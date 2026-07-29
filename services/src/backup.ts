import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { canonicalJsonStringify, type JsonObject } from "@a1/core";

import type { ObjectStorage } from "./object-storage.js";

export interface BackupSource {
  readonly name: string;
  snapshot(): Promise<Uint8Array>;
}
export interface RestoreTarget {
  readonly name: string;
  restore(body: Uint8Array): Promise<void>;
}
interface BackupEntry {
  readonly key: string;
  readonly name: string;
  readonly sha256: string;
  readonly size: number;
}
export interface BackupManifest {
  readonly completedAt: string;
  readonly createdAt: string;
  readonly entries: readonly BackupEntry[];
  readonly id: string;
  readonly version: 1;
}

function parseManifest(value: unknown): BackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Backup manifest must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    typeof record.createdAt !== "string" ||
    typeof record.completedAt !== "string" ||
    !Array.isArray(record.entries)
  ) {
    throw new TypeError("Backup manifest is invalid.");
  }
  const entries = record.entries.map((entry): BackupEntry => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new TypeError("Backup manifest entry is invalid.");
    }
    const item = entry as Record<string, unknown>;
    if (
      typeof item.key !== "string" ||
      typeof item.name !== "string" ||
      typeof item.sha256 !== "string" ||
      typeof item.size !== "number"
    ) {
      throw new TypeError("Backup manifest entry is invalid.");
    }
    return { key: item.key, name: item.name, sha256: item.sha256, size: item.size };
  });
  return {
    completedAt: record.completedAt,
    createdAt: record.createdAt,
    entries,
    id: record.id,
    version: 1
  };
}

export class FileBackupSource implements BackupSource {
  public constructor(
    public readonly name: string,
    private readonly path: string
  ) {}
  public snapshot(): Promise<Uint8Array> {
    return readFile(this.path);
  }
}

export class FileRestoreTarget implements RestoreTarget {
  public constructor(
    public readonly name: string,
    private readonly path: string
  ) {}
  public async restore(body: Uint8Array): Promise<void> {
    await mkdir(dirname(this.path), { mode: 0o700, recursive: true });
    const temporary = `${this.path}.${randomUUID()}.restore`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(body);
      await handle.sync();
      await handle.close();
      await rename(temporary, this.path);
    } catch (error: unknown) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  }
}

export class BackupService {
  public constructor(private readonly storage: ObjectStorage) {}

  public async create(sources: readonly BackupSource[]): Promise<BackupManifest> {
    const id = `${new Date().toISOString().replaceAll(/[:.]/gu, "-")}-${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const entries: BackupEntry[] = [];
    for (const source of sources) {
      const body = await source.snapshot();
      const key = `backups/${id}/objects/${encodeURIComponent(source.name)}`;
      const sha256 = createHash("sha256").update(body).digest("hex");
      await this.storage.put({
        body,
        contentType: "application/octet-stream",
        key,
        metadata: { sha256, source: source.name }
      });
      entries.push({ key, name: source.name, sha256, size: body.byteLength });
    }
    const manifest: BackupManifest = {
      completedAt: new Date().toISOString(),
      createdAt,
      entries,
      id,
      version: 1
    };
    await this.storage.put({
      body: new TextEncoder().encode(canonicalJsonStringify(manifest as unknown as JsonObject)),
      contentType: "application/json",
      key: `backups/${id}/manifest.json`
    });
    return manifest;
  }

  public async list(): Promise<readonly BackupManifest[]> {
    const summaries = await this.storage.list("backups");
    const manifests = await Promise.all(
      summaries
        .filter((summary) => summary.key.endsWith("/manifest.json"))
        .map(async (summary) => {
          const stored = await this.storage.get(summary.key);
          if (stored === undefined) throw new Error(`Backup manifest "${summary.key}" is missing.`);
          const value: unknown = JSON.parse(new TextDecoder().decode(stored.body));
          return parseManifest(value);
        })
    );
    return manifests.sort((left, right) => right.completedAt.localeCompare(left.completedAt));
  }

  public async restore(
    backupId: string,
    targets: readonly RestoreTarget[]
  ): Promise<BackupManifest> {
    const stored = await this.storage.get(`backups/${backupId}/manifest.json`);
    if (stored === undefined) throw new Error(`Backup "${backupId}" does not exist.`);
    const value: unknown = JSON.parse(new TextDecoder().decode(stored.body));
    const manifest = parseManifest(value);
    const targetMap = new Map(targets.map((target) => [target.name, target]));
    for (const entry of manifest.entries) {
      const target = targetMap.get(entry.name);
      if (target === undefined) throw new Error(`No restore target for "${entry.name}".`);
      const object = await this.storage.get(entry.key);
      if (object === undefined) throw new Error(`Backup object "${entry.key}" is missing.`);
      const hash = createHash("sha256").update(object.body).digest("hex");
      if (hash !== entry.sha256 || object.body.byteLength !== entry.size) {
        throw new Error(`Backup object "${entry.name}" failed integrity verification.`);
      }
      await target.restore(object.body);
    }
    return manifest;
  }
}
