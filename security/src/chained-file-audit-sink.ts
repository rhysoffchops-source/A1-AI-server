import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { assertJsonValue, canonicalJsonStringify, type JsonObject, type JsonValue } from "@a1/core";

import type { AuditEnvelope, AuditSink } from "./audit.js";

const GENESIS_HASH = "0".repeat(64);

interface StoredAuditRecord {
  readonly envelope: AuditEnvelope;
  readonly hash: string;
  readonly previousHash: string;
  readonly sequence: number;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Audit record field "${key}" must be a non-empty string.`);
  }
  return value;
}

function parseActor(value: unknown): AuditEnvelope["actor"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Audit actor must be an object.");
  }

  const record = value as Record<string, unknown>;
  const kind = requiredString(record, "kind");
  if (!["agent", "plugin", "service", "system", "user"].includes(kind)) {
    throw new Error(`Unsupported audit actor kind "${kind}".`);
  }

  return {
    id: requiredString(record, "id"),
    kind: kind as AuditEnvelope["actor"]["kind"]
  };
}

function parseTarget(value: unknown): AuditEnvelope["target"] {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Audit target must be an object.");
  }

  const record = value as Record<string, unknown>;
  return {
    id: requiredString(record, "id"),
    type: requiredString(record, "type")
  };
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Audit record field "${key}" must be a non-empty string when present.`);
  }
  return value;
}

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEnvelope(value: unknown): AuditEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Audit envelope must be an object.");
  }

  const record = value as Record<string, unknown>;
  const metadata = record.metadata;
  assertJsonValue(metadata, "audit metadata");
  if (!isJsonObject(metadata)) {
    throw new Error("Audit metadata must be a JSON object.");
  }

  const outcome = requiredString(record, "outcome");
  if (!["denied", "failure", "success"].includes(outcome)) {
    throw new Error(`Unsupported audit outcome "${outcome}".`);
  }

  const severity = requiredString(record, "severity");
  if (!["critical", "info", "warning"].includes(severity)) {
    throw new Error(`Unsupported audit severity "${severity}".`);
  }

  const causationId = optionalString(record, "causationId");
  const correlationId = optionalString(record, "correlationId");
  const reason = optionalString(record, "reason");
  const target = parseTarget(record.target);

  return {
    action: requiredString(record, "action"),
    actor: parseActor(record.actor),
    ...(causationId === undefined ? {} : { causationId }),
    ...(correlationId === undefined ? {} : { correlationId }),
    id: requiredString(record, "id"),
    metadata,
    occurredAt: requiredString(record, "occurredAt"),
    outcome: outcome as AuditEnvelope["outcome"],
    ...(reason === undefined ? {} : { reason }),
    severity: severity as AuditEnvelope["severity"],
    ...(target === undefined ? {} : { target })
  };
}

function recordHash(sequence: number, previousHash: string, envelope: AuditEnvelope): string {
  const hashInput: JsonObject = {
    envelope: envelope as unknown as JsonValue,
    previousHash,
    sequence
  };
  return createHash("sha256").update(canonicalJsonStringify(hashInput)).digest("hex");
}

function parseStoredRecord(line: string): StoredAuditRecord {
  const value = JSON.parse(line) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Audit log line must be an object.");
  }

  const record = value as Record<string, unknown>;
  const sequence = record.sequence;
  if (!Number.isSafeInteger(sequence) || (sequence as number) <= 0) {
    throw new Error("Audit sequence must be a positive integer.");
  }

  return {
    envelope: parseEnvelope(record.envelope),
    hash: requiredString(record, "hash"),
    previousHash: requiredString(record, "previousHash"),
    sequence: sequence as number
  };
}

function serializeStoredRecord(record: StoredAuditRecord): string {
  const jsonRecord: JsonObject = {
    envelope: record.envelope as unknown as JsonValue,
    hash: record.hash,
    previousHash: record.previousHash,
    sequence: record.sequence
  };
  return `${canonicalJsonStringify(jsonRecord)}\n`;
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ESRCH") {
      return false;
    }
    if (isNodeError(error) && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

export interface ChainedFileAuditSinkOptions {
  readonly filePath: string;
  readonly syncWrites: boolean;
}

export class ChainedFileAuditSink implements AuditSink {
  readonly #filePath: string;
  readonly #lockPath: string;
  readonly #syncWrites: boolean;
  #fileHandle: FileHandle | undefined;
  #lockHandle: FileHandle | undefined;
  #appendError: Error | undefined;
  #previousHash = GENESIS_HASH;
  #sequence = 0;
  #writeTail: Promise<void> = Promise.resolve();

  public constructor(options: ChainedFileAuditSinkOptions) {
    this.#filePath = options.filePath;
    this.#lockPath = `${options.filePath}.lock`;
    this.#syncWrites = options.syncWrites;
  }

  public async open(): Promise<void> {
    if (this.#fileHandle !== undefined) {
      throw new Error("Audit sink is already open.");
    }

    await mkdir(dirname(this.#filePath), { mode: 0o700, recursive: true });
    await this.#acquireLock();

    try {
      this.#fileHandle = await open(
        this.#filePath,
        constants.O_APPEND | constants.O_CREAT | constants.O_RDWR,
        0o600
      );
      await chmod(this.#filePath, 0o600);
      await this.#loadAndVerify();
    } catch (error: unknown) {
      await this.#releaseResources();
      throw error;
    }
  }

  public async append(envelope: AuditEnvelope): Promise<void> {
    if (this.#fileHandle === undefined) {
      throw new Error("Audit sink is not open.");
    }

    const appendOperation = this.#writeTail.then(async () => {
      if (this.#appendError !== undefined) {
        throw new Error("Audit sink cannot append after a previous write failure.", {
          cause: this.#appendError
        });
      }
      try {
        await this.#appendInternal(envelope);
      } catch (error: unknown) {
        this.#appendError =
          error instanceof Error ? error : new Error("Audit append failed with a non-error value.");
        throw error;
      }
    });
    this.#writeTail = appendOperation.catch(() => undefined);
    await appendOperation;
  }

  public async close(): Promise<void> {
    await this.#writeTail;
    await this.#releaseResources();
  }

  async #appendInternal(envelope: AuditEnvelope): Promise<void> {
    const fileHandle = this.#fileHandle;
    if (fileHandle === undefined) {
      throw new Error("Audit sink closed before the record could be written.");
    }

    const validatedEnvelope = parseEnvelope(envelope);
    const sequence = this.#sequence + 1;
    const hash = recordHash(sequence, this.#previousHash, validatedEnvelope);
    const storedRecord: StoredAuditRecord = {
      envelope: validatedEnvelope,
      hash,
      previousHash: this.#previousHash,
      sequence
    };

    await fileHandle.appendFile(serializeStoredRecord(storedRecord), "utf8");
    if (this.#syncWrites) {
      await fileHandle.sync();
    }

    this.#sequence = sequence;
    this.#previousHash = hash;
  }

  async #loadAndVerify(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.#filePath, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    const lines = contents.length === 0 ? [] : contents.split("\n");
    if (lines.at(-1) === "") {
      lines.pop();
    }
    if (lines.some((line) => line.length === 0)) {
      throw new Error("Audit log contains an empty record.");
    }

    let expectedPreviousHash = GENESIS_HASH;
    let expectedSequence = 1;
    for (const line of lines) {
      const record = parseStoredRecord(line);
      if (record.sequence !== expectedSequence) {
        throw new Error(`Audit sequence break at record ${String(expectedSequence)}.`);
      }
      if (record.previousHash !== expectedPreviousHash) {
        throw new Error(`Audit hash-chain break at record ${String(expectedSequence)}.`);
      }
      const expectedHash = recordHash(record.sequence, record.previousHash, record.envelope);
      if (record.hash !== expectedHash) {
        throw new Error(`Audit record ${String(expectedSequence)} failed integrity verification.`);
      }

      expectedPreviousHash = record.hash;
      expectedSequence += 1;
    }

    this.#sequence = expectedSequence - 1;
    this.#previousHash = expectedPreviousHash;
  }

  async #acquireLock(): Promise<void> {
    const acquire = async (): Promise<void> => {
      this.#lockHandle = await open(this.#lockPath, "wx", 0o600);
      await this.#lockHandle.writeFile(
        JSON.stringify({
          createdAt: new Date().toISOString(),
          pid: process.pid
        }),
        "utf8"
      );
      await this.#lockHandle.sync();
    };

    try {
      await acquire();
      return;
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }
    }

    let lock: unknown;
    try {
      lock = JSON.parse(await readFile(this.#lockPath, "utf8")) as unknown;
    } catch (error: unknown) {
      throw new Error(`Audit lock at "${this.#lockPath}" is unreadable.`, { cause: error });
    }

    const pid =
      typeof lock === "object" &&
      lock !== null &&
      !Array.isArray(lock) &&
      Number.isSafeInteger((lock as Record<string, unknown>).pid)
        ? ((lock as Record<string, unknown>).pid as number)
        : undefined;

    if (pid === undefined || processIsRunning(pid)) {
      throw new Error(`Audit log at "${this.#filePath}" already has an active writer.`);
    }

    await unlink(this.#lockPath);
    await acquire();
  }

  async #releaseResources(): Promise<void> {
    const fileHandle = this.#fileHandle;
    const lockHandle = this.#lockHandle;
    this.#fileHandle = undefined;
    this.#lockHandle = undefined;

    await fileHandle?.close();
    await lockHandle?.close();
    if (lockHandle !== undefined) {
      try {
        await unlink(this.#lockPath);
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}
