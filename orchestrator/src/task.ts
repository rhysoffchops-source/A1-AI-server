import type { JsonValue } from "@a1/core";

export type TaskStatus = "cancelled" | "failed" | "queued" | "running" | "succeeded";

export interface TaskFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface TaskRecord {
  readonly attempt: number;
  readonly correlationId?: string;
  readonly createdAt: string;
  readonly failure?: TaskFailure;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly kind: string;
  readonly leaseExpiresAt?: string;
  readonly leaseOwner?: string;
  readonly leaseToken?: string;
  readonly maxAttempts: number;
  readonly payload: JsonValue;
  readonly priority: number;
  readonly result?: JsonValue;
  readonly runAt: string;
  readonly status: TaskStatus;
  readonly timeoutMs: number;
  readonly updatedAt: string;
}

export interface ScheduleTaskInput {
  readonly correlationId?: string;
  readonly idempotencyKey?: string;
  readonly kind: string;
  readonly maxAttempts?: number;
  readonly payload: JsonValue;
  readonly priority?: number;
  readonly runAt?: Date;
  readonly timeoutMs?: number;
}

export interface EnqueueTaskInput {
  readonly compareRunAt: boolean;
  readonly correlationId?: string;
  readonly createdAt: string;
  readonly id: string;
  readonly idempotencyKey?: string;
  readonly kind: string;
  readonly maxAttempts: number;
  readonly payload: JsonValue;
  readonly priority: number;
  readonly runAt: string;
  readonly timeoutMs: number;
}

export interface EnqueueTaskResult {
  readonly created: boolean;
  readonly task: TaskRecord;
}

export interface ClaimTasksInput {
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly now: string;
  readonly workerId: string;
}

export interface FailTaskInput {
  readonly failure: TaskFailure;
  readonly leaseToken: string;
  readonly nextRunAt?: string;
  readonly taskId: string;
  readonly terminal: boolean;
  readonly updatedAt: string;
}

export interface TaskStore {
  cancel(taskId: string, updatedAt: string): Promise<TaskRecord | undefined>;
  claimDue(input: ClaimTasksInput): Promise<readonly TaskRecord[]>;
  close(): Promise<void>;
  complete(
    taskId: string,
    leaseToken: string,
    result: JsonValue,
    updatedAt: string
  ): Promise<TaskRecord>;
  enqueue(input: EnqueueTaskInput): Promise<EnqueueTaskResult>;
  fail(input: FailTaskInput): Promise<TaskRecord>;
  failExpiredLeases(updatedAt: string): Promise<readonly TaskRecord[]>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(limit: number, status?: TaskStatus): Promise<readonly TaskRecord[]>;
  open(): Promise<void>;
  ping(): Promise<void>;
  release(taskId: string, leaseToken: string, nextRunAt: string, updatedAt: string): Promise<void>;
  renewLease(
    taskId: string,
    leaseToken: string,
    leaseExpiresAt: string,
    updatedAt: string
  ): Promise<boolean>;
}

export interface TaskExecutionContext {
  readonly attempt: number;
  readonly correlationId?: string;
  readonly signal: AbortSignal;
  readonly taskId: string;
}

export interface TaskHandler<TPayload extends JsonValue = JsonValue> {
  readonly kind: string;
  execute(context: TaskExecutionContext, payload: TPayload): Promise<JsonValue | undefined>;
  parse(payload: JsonValue): TPayload;
}

export class TaskExecutionError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "TaskExecutionError";
  }
}

export class TaskLeaseLostError extends Error {
  public constructor(taskId: string) {
    super(`Lease for task "${taskId}" is no longer valid.`);
    this.name = "TaskLeaseLostError";
  }
}

export class TaskIdempotencyConflictError extends Error {
  public constructor(idempotencyKey: string) {
    super(`Idempotency key "${idempotencyKey}" is already used by a different task.`);
    this.name = "TaskIdempotencyConflictError";
  }
}
