import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { assertJsonValue, canonicalJsonStringify, type JsonValue } from "@a1/core";
import {
  TaskIdempotencyConflictError,
  TaskLeaseLostError,
  type ClaimTasksInput,
  type EnqueueTaskInput,
  type EnqueueTaskResult,
  type FailTaskInput,
  type TaskFailure,
  type TaskRecord,
  type TaskStatus,
  type TaskStore
} from "@a1/orchestrator";
import Database from "better-sqlite3";

interface TaskRow {
  readonly attempt: number;
  readonly correlation_id: string | null;
  readonly created_at: string;
  readonly failure_code: string | null;
  readonly failure_message: string | null;
  readonly failure_retryable: number | null;
  readonly id: string;
  readonly idempotency_key: string | null;
  readonly kind: string;
  readonly lease_expires_at: string | null;
  readonly lease_owner: string | null;
  readonly lease_token: string | null;
  readonly max_attempts: number;
  readonly payload_json: string;
  readonly priority: number;
  readonly result_json: string | null;
  readonly run_at: string;
  readonly status: string;
  readonly timeout_ms: number;
  readonly updated_at: string;
}

const TASK_STATUSES: readonly TaskStatus[] = [
  "cancelled",
  "failed",
  "queued",
  "running",
  "succeeded"
];

function parseJson(value: string, field: string): JsonValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored task ${field} is not valid JSON.`, { cause: error });
  }
  assertJsonValue(parsed, `stored task ${field}`);
  return parsed;
}

function optionalField<T>(value: T | null, key: string): Readonly<Record<string, T>> | object {
  return value === null ? {} : { [key]: value };
}

function toTaskRecord(row: TaskRow): TaskRecord {
  if (!TASK_STATUSES.includes(row.status as TaskStatus)) {
    throw new Error(`Stored task "${row.id}" has invalid status "${row.status}".`);
  }

  let failure: TaskFailure | undefined;
  if (row.failure_code !== null || row.failure_message !== null || row.failure_retryable !== null) {
    if (
      row.failure_code === null ||
      row.failure_message === null ||
      row.failure_retryable === null
    ) {
      throw new Error(`Stored task "${row.id}" has an incomplete failure record.`);
    }
    failure = {
      code: row.failure_code,
      message: row.failure_message,
      retryable: row.failure_retryable === 1
    };
  }

  return {
    attempt: row.attempt,
    ...optionalField(row.correlation_id, "correlationId"),
    createdAt: row.created_at,
    ...(failure === undefined ? {} : { failure }),
    id: row.id,
    ...optionalField(row.idempotency_key, "idempotencyKey"),
    kind: row.kind,
    ...optionalField(row.lease_expires_at, "leaseExpiresAt"),
    ...optionalField(row.lease_owner, "leaseOwner"),
    ...optionalField(row.lease_token, "leaseToken"),
    maxAttempts: row.max_attempts,
    payload: parseJson(row.payload_json, "payload"),
    priority: row.priority,
    ...(row.result_json === null ? {} : { result: parseJson(row.result_json, "result") }),
    runAt: row.run_at,
    status: row.status as TaskStatus,
    timeoutMs: row.timeout_ms,
    updatedAt: row.updated_at
  };
}

function row(value: unknown): TaskRow {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Task database returned an invalid row.");
  }
  return value as TaskRow;
}

function rows(value: unknown): TaskRow[] {
  if (!Array.isArray(value)) {
    throw new Error("Task database returned an invalid row collection.");
  }
  return value.map((item) => row(item));
}

export interface SqliteTaskStoreOptions {
  readonly busyTimeoutMs: number;
  readonly filePath: string;
}

export class SqliteTaskStore implements TaskStore {
  #database: Database.Database | undefined;

  public constructor(private readonly options: SqliteTaskStoreOptions) {
    if (!Number.isSafeInteger(options.busyTimeoutMs) || options.busyTimeoutMs <= 0) {
      throw new RangeError("SQLite busy timeout must be a positive integer.");
    }
  }

  public async open(): Promise<void> {
    if (this.#database !== undefined) {
      throw new Error("SQLite task store is already open.");
    }

    await mkdir(dirname(this.options.filePath), { recursive: true });
    const database = new Database(this.options.filePath);
    try {
      database.pragma(`busy_timeout = ${String(this.options.busyTimeoutMs)}`);
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      database.pragma("synchronous = FULL");
      database.exec(`
        CREATE TABLE IF NOT EXISTS a1_schema_migrations (
          component TEXT NOT NULL,
          version INTEGER NOT NULL,
          applied_at TEXT NOT NULL,
          PRIMARY KEY (component, version)
        );

        CREATE TABLE IF NOT EXISTS scheduler_tasks (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
          priority INTEGER NOT NULL,
          run_at TEXT NOT NULL,
          attempt INTEGER NOT NULL,
          max_attempts INTEGER NOT NULL,
          timeout_ms INTEGER NOT NULL,
          idempotency_key TEXT UNIQUE,
          correlation_id TEXT,
          lease_owner TEXT,
          lease_token TEXT,
          lease_expires_at TEXT,
          result_json TEXT,
          failure_code TEXT,
          failure_message TEXT,
          failure_retryable INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS scheduler_tasks_due
          ON scheduler_tasks (status, run_at, priority DESC);
        CREATE INDEX IF NOT EXISTS scheduler_tasks_lease
          ON scheduler_tasks (status, lease_expires_at);

        INSERT OR IGNORE INTO a1_schema_migrations (component, version, applied_at)
          VALUES ('scheduler', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
      `);
      this.#database = database;
    } catch (error: unknown) {
      database.close();
      throw error;
    }
  }

  public async close(): Promise<void> {
    await Promise.resolve();
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  public async enqueue(input: EnqueueTaskInput): Promise<EnqueueTaskResult> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const payloadJson = canonicalJsonStringify(input.payload);
    const transaction = database.transaction((): EnqueueTaskResult => {
      if (input.idempotencyKey !== undefined) {
        const existingValue = database
          .prepare("SELECT * FROM scheduler_tasks WHERE idempotency_key = ?")
          .get(input.idempotencyKey);
        if (existingValue !== undefined) {
          const existing = toTaskRecord(row(existingValue));
          if (
            existing.kind !== input.kind ||
            canonicalJsonStringify(existing.payload) !== payloadJson ||
            existing.maxAttempts !== input.maxAttempts ||
            existing.priority !== input.priority ||
            (input.compareRunAt && existing.runAt !== input.runAt) ||
            existing.timeoutMs !== input.timeoutMs ||
            existing.correlationId !== input.correlationId
          ) {
            throw new TaskIdempotencyConflictError(input.idempotencyKey);
          }
          return {
            created: false,
            task: existing
          };
        }
      }

      database
        .prepare(
          `INSERT INTO scheduler_tasks (
            id, kind, payload_json, status, priority, run_at, attempt, max_attempts,
            timeout_ms, idempotency_key, correlation_id, created_at, updated_at
          ) VALUES (
            @id, @kind, @payloadJson, 'queued', @priority, @runAt, 0, @maxAttempts,
            @timeoutMs, @idempotencyKey, @correlationId, @createdAt, @createdAt
          )`
        )
        .run({
          correlationId: input.correlationId ?? null,
          createdAt: input.createdAt,
          id: input.id,
          idempotencyKey: input.idempotencyKey ?? null,
          kind: input.kind,
          maxAttempts: input.maxAttempts,
          payloadJson,
          priority: input.priority,
          runAt: input.runAt,
          timeoutMs: input.timeoutMs
        });

      return {
        created: true,
        task: this.#getRequired(input.id)
      };
    });

    return transaction.immediate();
  }

  public async claimDue(input: ClaimTasksInput): Promise<readonly TaskRecord[]> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const leaseExpiresAt = new Date(
      new Date(input.now).getTime() + input.leaseDurationMs
    ).toISOString();
    const transaction = database.transaction((): readonly TaskRecord[] => {
      const candidates = rows(
        database
          .prepare(
            `SELECT * FROM scheduler_tasks
             WHERE (status = 'queued' AND run_at <= @now)
                OR (status = 'running' AND lease_expires_at <= @now AND attempt < max_attempts)
             ORDER BY priority DESC, run_at ASC, created_at ASC
             LIMIT @limit`
          )
          .all({ limit: input.limit, now: input.now })
      );

      const claimed: TaskRecord[] = [];
      for (const candidate of candidates) {
        const leaseToken = randomUUID();
        const result = database
          .prepare(
            `UPDATE scheduler_tasks
             SET status = 'running',
                 attempt = attempt + 1,
                 lease_owner = @workerId,
                 lease_token = @leaseToken,
                 lease_expires_at = @leaseExpiresAt,
                 failure_code = NULL,
                 failure_message = NULL,
                 failure_retryable = NULL,
                 updated_at = @now
             WHERE id = @id
               AND (
                 (status = 'queued' AND run_at <= @now)
                 OR (status = 'running' AND lease_expires_at <= @now AND attempt < max_attempts)
               )`
          )
          .run({
            id: candidate.id,
            leaseExpiresAt,
            leaseToken,
            now: input.now,
            workerId: input.workerId
          });
        if (result.changes === 1) {
          claimed.push(this.#getRequired(candidate.id));
        }
      }

      return claimed;
    });

    return transaction.immediate();
  }

  public async failExpiredLeases(updatedAt: string): Promise<readonly TaskRecord[]> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const transaction = database.transaction((): readonly TaskRecord[] => {
      const expired = rows(
        database
          .prepare(
            `SELECT * FROM scheduler_tasks
             WHERE status = 'running'
               AND lease_expires_at <= @updatedAt
               AND attempt >= max_attempts`
          )
          .all({ updatedAt })
      );
      if (expired.length === 0) {
        return [];
      }

      const update = database.prepare(
        `UPDATE scheduler_tasks
         SET status = 'failed',
             failure_code = 'TASK_LEASE_EXPIRED',
             failure_message = 'Task lease expired after the final allowed attempt.',
             failure_retryable = 0,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = @updatedAt
         WHERE id = @id
           AND status = 'running'
           AND lease_expires_at <= @updatedAt
           AND attempt >= max_attempts`
      );
      const failed: TaskRecord[] = [];
      for (const task of expired) {
        if (update.run({ id: task.id, updatedAt }).changes === 1) {
          failed.push(this.#getRequired(task.id));
        }
      }
      return failed;
    });

    return transaction.immediate();
  }

  public async complete(
    taskId: string,
    leaseToken: string,
    result: JsonValue,
    updatedAt: string
  ): Promise<TaskRecord> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const update = database
      .prepare(
        `UPDATE scheduler_tasks
         SET status = 'succeeded',
             result_json = @resultJson,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = @updatedAt
         WHERE id = @taskId
           AND status = 'running'
           AND lease_token = @leaseToken
           AND lease_expires_at > @updatedAt`
      )
      .run({
        leaseToken,
        resultJson: canonicalJsonStringify(result),
        taskId,
        updatedAt
      });
    if (update.changes !== 1) {
      throw new TaskLeaseLostError(taskId);
    }
    return this.#getRequired(taskId);
  }

  public async fail(input: FailTaskInput): Promise<TaskRecord> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const update = database
      .prepare(
        `UPDATE scheduler_tasks
         SET status = @status,
             run_at = @runAt,
             failure_code = @failureCode,
             failure_message = @failureMessage,
             failure_retryable = @failureRetryable,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = @updatedAt
         WHERE id = @taskId
           AND status = 'running'
           AND lease_token = @leaseToken
           AND lease_expires_at > @updatedAt`
      )
      .run({
        failureCode: input.failure.code,
        failureMessage: input.failure.message,
        failureRetryable: input.failure.retryable ? 1 : 0,
        leaseToken: input.leaseToken,
        runAt: input.nextRunAt ?? input.updatedAt,
        status: input.terminal ? "failed" : "queued",
        taskId: input.taskId,
        updatedAt: input.updatedAt
      });
    if (update.changes !== 1) {
      throw new TaskLeaseLostError(input.taskId);
    }
    return this.#getRequired(input.taskId);
  }

  public async cancel(taskId: string, updatedAt: string): Promise<TaskRecord | undefined> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const update = database
      .prepare(
        `UPDATE scheduler_tasks
         SET status = 'cancelled',
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = @updatedAt
         WHERE id = @taskId AND status IN ('queued', 'running')`
      )
      .run({ taskId, updatedAt });
    return update.changes === 1 ? this.#getRequired(taskId) : undefined;
  }

  public async release(
    taskId: string,
    leaseToken: string,
    nextRunAt: string,
    updatedAt: string
  ): Promise<void> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const update = database
      .prepare(
        `UPDATE scheduler_tasks
         SET status = 'queued',
             run_at = @nextRunAt,
             attempt = CASE WHEN attempt > 0 THEN attempt - 1 ELSE 0 END,
             lease_owner = NULL,
             lease_token = NULL,
             lease_expires_at = NULL,
             updated_at = @updatedAt
         WHERE id = @taskId
           AND status = 'running'
           AND lease_token = @leaseToken
           AND lease_expires_at > @updatedAt`
      )
      .run({ leaseToken, nextRunAt, taskId, updatedAt });
    if (update.changes !== 1) {
      throw new TaskLeaseLostError(taskId);
    }
  }

  public async renewLease(
    taskId: string,
    leaseToken: string,
    leaseExpiresAt: string,
    updatedAt: string
  ): Promise<boolean> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const update = database
      .prepare(
        `UPDATE scheduler_tasks
         SET lease_expires_at = @leaseExpiresAt, updated_at = @updatedAt
         WHERE id = @taskId
           AND status = 'running'
           AND lease_token = @leaseToken
           AND lease_expires_at > @updatedAt`
      )
      .run({ leaseExpiresAt, leaseToken, taskId, updatedAt });
    return update.changes === 1;
  }

  public async get(taskId: string): Promise<TaskRecord | undefined> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const value = database.prepare("SELECT * FROM scheduler_tasks WHERE id = ?").get(taskId);
    return value === undefined ? undefined : toTaskRecord(row(value));
  }

  public async list(limit: number, status?: TaskStatus): Promise<readonly TaskRecord[]> {
    await Promise.resolve();
    const database = this.#requiredDatabase();
    const values =
      status === undefined
        ? database
            .prepare(
              "SELECT * FROM scheduler_tasks ORDER BY updated_at DESC, created_at DESC LIMIT ?"
            )
            .all(limit)
        : database
            .prepare(
              `SELECT * FROM scheduler_tasks
               WHERE status = ?
               ORDER BY updated_at DESC, created_at DESC
               LIMIT ?`
            )
            .all(status, limit);
    return rows(values).map((value) => toTaskRecord(value));
  }

  public async ping(): Promise<void> {
    await Promise.resolve();
    this.#requiredDatabase().prepare("SELECT 1").get();
  }

  #getRequired(taskId: string): TaskRecord {
    const value = this.#requiredDatabase()
      .prepare("SELECT * FROM scheduler_tasks WHERE id = ?")
      .get(taskId);
    if (value === undefined) {
      throw new Error(`Task "${taskId}" was not found after a database mutation.`);
    }
    return toTaskRecord(row(value));
  }

  #requiredDatabase(): Database.Database {
    if (this.#database === undefined) {
      throw new Error("SQLite task store is not open.");
    }
    return this.#database;
  }
}
