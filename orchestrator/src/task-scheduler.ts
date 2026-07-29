import { randomUUID } from "node:crypto";

import {
  assertJsonValue,
  type EventPublisher,
  type HealthCheckResult,
  type JsonObject,
  type JsonValue,
  type LifecycleComponent,
  type Logger
} from "@a1/core";
import type { AuditRecorder } from "@a1/security";

import {
  TaskExecutionError,
  TaskLeaseLostError,
  type ScheduleTaskInput,
  type TaskFailure,
  type TaskHandler,
  type TaskRecord,
  type TaskStore
} from "./task.js";

export interface TaskEventMap {
  "task.cancelled": {
    readonly kind: string;
    readonly taskId: string;
  };
  "task.completed": {
    readonly attempt: number;
    readonly kind: string;
    readonly taskId: string;
  };
  "task.failed": {
    readonly attempt: number;
    readonly code: string;
    readonly kind: string;
    readonly taskId: string;
  };
  "task.retry-scheduled": {
    readonly attempt: number;
    readonly kind: string;
    readonly nextRunAt: string;
    readonly taskId: string;
  };
  "task.scheduled": {
    readonly kind: string;
    readonly runAt: string;
    readonly taskId: string;
  };
  "task.started": {
    readonly attempt: number;
    readonly kind: string;
    readonly taskId: string;
  };
}

export interface TaskSchedulerOptions {
  readonly audit: AuditRecorder;
  readonly claimBatchSize: number;
  readonly defaultMaxAttempts: number;
  readonly defaultTaskTimeoutMs: number;
  readonly events: EventPublisher<TaskEventMap>;
  readonly leaseDurationMs: number;
  readonly logger: Logger;
  readonly maxConcurrency: number;
  readonly pollIntervalMs: number;
  readonly random?: () => number;
  readonly retryBaseDelayMs: number;
  readonly retryJitter: number;
  readonly retryMaxDelayMs: number;
  readonly store: TaskStore;
  readonly workerId: string;
}

interface RunningTask {
  readonly abortController: AbortController;
  readonly promise: Promise<void>;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Operation was aborted."));
      return;
    }

    const timer = setTimeout(resolve, ms);
    timer.unref();
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(
          signal.reason instanceof Error ? signal.reason : new Error("Operation was aborted.")
        );
      },
      { once: true }
    );
  });
}

function taskFailure(error: unknown): TaskFailure {
  if (error instanceof TaskExecutionError) {
    return {
      code: error.code,
      message: error.message.slice(0, 2_000),
      retryable: error.retryable
    };
  }
  if (error instanceof Error) {
    return {
      code: error.name === "AbortError" ? "TASK_ABORTED" : "TASK_EXECUTION_FAILED",
      message: error.message.slice(0, 2_000),
      retryable: true
    };
  }
  return {
    code: "NON_ERROR_THROWN",
    message: "Task failed with a non-error value.",
    retryable: false
  };
}

export class TaskScheduler implements LifecycleComponent {
  public readonly name = "task-scheduler";
  readonly #handlers = new Map<string, TaskHandler>();
  readonly #runningTasks = new Map<string, RunningTask>();
  readonly #shutdownController = new AbortController();
  readonly #random: () => number;
  #loopPromise: Promise<void> | undefined;
  #state: "failed" | "idle" | "running" | "starting" | "stopped" | "stopping" = "idle";

  public constructor(private readonly options: TaskSchedulerOptions) {
    for (const [name, value] of Object.entries({
      claimBatchSize: options.claimBatchSize,
      defaultMaxAttempts: options.defaultMaxAttempts,
      defaultTaskTimeoutMs: options.defaultTaskTimeoutMs,
      leaseDurationMs: options.leaseDurationMs,
      maxConcurrency: options.maxConcurrency,
      pollIntervalMs: options.pollIntervalMs,
      retryBaseDelayMs: options.retryBaseDelayMs,
      retryMaxDelayMs: options.retryMaxDelayMs
    })) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer.`);
      }
    }
    if (options.retryJitter < 0 || options.retryJitter > 1) {
      throw new RangeError("retryJitter must be between 0 and 1.");
    }
    this.#random = options.random ?? Math.random;
  }

  public registerHandler<TPayload extends JsonValue>(handler: TaskHandler<TPayload>): void {
    if (this.#state !== "idle") {
      throw new Error("Task handlers can only be registered before the scheduler starts.");
    }
    const kind = handler.kind.trim();
    if (kind.length === 0) {
      throw new TypeError("Task handler kind cannot be empty.");
    }
    if (this.#handlers.has(kind)) {
      throw new Error(`Task handler "${kind}" is already registered.`);
    }
    this.#handlers.set(kind, handler);
  }

  public async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new Error(`Task scheduler cannot start from state "${this.#state}".`);
    }
    this.#state = "starting";
    try {
      await this.options.store.open();
      this.#state = "running";
      this.#loopPromise = this.#runLoop();
    } catch (error: unknown) {
      this.#state = "failed";
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopping") {
      await this.#loopPromise;
      return;
    }

    this.#state = "stopping";
    this.#shutdownController.abort(new Error("Task scheduler is stopping."));
    for (const running of this.#runningTasks.values()) {
      running.abortController.abort(new Error("Task scheduler is stopping."));
    }

    await this.#loopPromise;
    await Promise.allSettled([...this.#runningTasks.values()].map(({ promise }) => promise));
    await this.options.store.close();
    this.#state = "stopped";
  }

  public async schedule(input: ScheduleTaskInput): Promise<TaskRecord> {
    if (this.#state !== "running") {
      throw new Error("Task scheduler is not running.");
    }

    const kind = input.kind.trim();
    if (kind.length === 0) {
      throw new TypeError("Task kind cannot be empty.");
    }
    assertJsonValue(input.payload, "task payload");

    const now = new Date();
    const runAt = input.runAt ?? now;
    const maxAttempts = input.maxAttempts ?? this.options.defaultMaxAttempts;
    const timeoutMs = input.timeoutMs ?? this.options.defaultTaskTimeoutMs;
    const priority = input.priority ?? 0;
    if (!Number.isSafeInteger(maxAttempts) || maxAttempts <= 0) {
      throw new RangeError("maxAttempts must be a positive integer.");
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("timeoutMs must be a positive integer.");
    }
    if (!Number.isSafeInteger(priority)) {
      throw new RangeError("priority must be an integer.");
    }

    const enqueued = await this.options.store.enqueue({
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      compareRunAt: input.runAt !== undefined,
      createdAt: now.toISOString(),
      id: randomUUID(),
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
      kind,
      maxAttempts,
      payload: input.payload,
      priority,
      runAt: runAt.toISOString(),
      timeoutMs
    });
    const { task } = enqueued;

    if (enqueued.created) {
      await this.#publish("task.scheduled", task);
      await this.#audit("task.schedule", task, "success", {
        runAt: task.runAt
      });
    }
    return task;
  }

  public async cancel(taskId: string): Promise<TaskRecord | undefined> {
    if (this.#state !== "running") {
      throw new Error("Task scheduler is not running.");
    }

    const task = await this.options.store.cancel(taskId, new Date().toISOString());
    if (task === undefined) {
      return undefined;
    }

    this.#runningTasks
      .get(taskId)
      ?.abortController.abort(
        new TaskExecutionError("Task was cancelled.", "TASK_CANCELLED", false)
      );
    await this.#publish("task.cancelled", task);
    await this.#audit("task.cancel", task, "success");
    return task;
  }

  public get(taskId: string): Promise<TaskRecord | undefined> {
    return this.options.store.get(taskId);
  }

  public list(limit: number, status?: TaskRecord["status"]): Promise<readonly TaskRecord[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
      throw new RangeError("Task list limit must be between 1 and 1000.");
    }
    return this.options.store.list(limit, status);
  }

  public async health(): Promise<HealthCheckResult> {
    if (this.#state !== "running") {
      return {
        message: `Task scheduler is ${this.#state}.`,
        status: "unhealthy"
      };
    }

    try {
      await this.options.store.ping();
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        message: error instanceof Error ? error.message : "Task store health check failed.",
        status: "unhealthy"
      };
    }
  }

  async #runLoop(): Promise<void> {
    while (this.#state === "running") {
      try {
        await this.#claimAvailableTasks();
      } catch (error: unknown) {
        this.options.logger.error({ err: error }, "Task scheduler poll failed");
      }

      try {
        await sleep(this.options.pollIntervalMs, this.#shutdownController.signal);
      } catch {
        break;
      }
    }
  }

  async #claimAvailableTasks(): Promise<void> {
    const expiredTasks = await this.options.store.failExpiredLeases(new Date().toISOString());
    for (const task of expiredTasks) {
      await this.#publish("task.failed", task);
      await this.#audit("task.fail", task, "failure", {
        code: task.failure?.code ?? "TASK_LEASE_EXPIRED"
      });
    }

    const capacity = this.options.maxConcurrency - this.#runningTasks.size;
    if (capacity <= 0) {
      return;
    }

    const tasks = await this.options.store.claimDue({
      leaseDurationMs: this.options.leaseDurationMs,
      limit: Math.min(capacity, this.options.claimBatchSize),
      now: new Date().toISOString(),
      workerId: this.options.workerId
    });

    for (const task of tasks) {
      const abortController = new AbortController();
      const promise = this.#execute(task, abortController).finally(() => {
        this.#runningTasks.delete(task.id);
      });
      this.#runningTasks.set(task.id, { abortController, promise });
    }
  }

  async #execute(task: TaskRecord, abortController: AbortController): Promise<void> {
    const leaseToken = task.leaseToken;
    if (leaseToken === undefined) {
      throw new TaskLeaseLostError(task.id);
    }

    const handler = this.#handlers.get(task.kind);
    if (handler === undefined) {
      await this.#handleFailure(
        task,
        leaseToken,
        new TaskExecutionError(
          `No handler is registered for task kind "${task.kind}".`,
          "TASK_HANDLER_NOT_REGISTERED",
          false
        )
      );
      return;
    }

    await this.#publish("task.started", task);
    await this.#audit("task.start", task, "success");

    const heartbeatController = new AbortController();
    const heartbeatPromise = this.#heartbeat(
      task,
      leaseToken,
      abortController,
      heartbeatController
    );

    try {
      const payload = handler.parse(task.payload);
      const result = await this.#executeWithTimeout(handler, task, payload, abortController);
      const jsonResult = result ?? null;
      assertJsonValue(jsonResult, "task result");
      const completed = await this.options.store.complete(
        task.id,
        leaseToken,
        jsonResult,
        new Date().toISOString()
      );
      await this.#publish("task.completed", completed);
      await this.#audit("task.complete", completed, "success");
    } catch (error: unknown) {
      if (this.#state === "stopping") {
        try {
          const timestamp = new Date().toISOString();
          await this.options.store.release(task.id, leaseToken, timestamp, timestamp);
        } catch (releaseError: unknown) {
          if (!(releaseError instanceof TaskLeaseLostError)) {
            this.options.logger.error(
              { err: releaseError, taskId: task.id },
              "Failed to release task during shutdown"
            );
          }
        }
        return;
      }

      const current = await this.options.store.get(task.id);
      if (current?.status === "cancelled") {
        return;
      }
      await this.#handleFailure(task, leaseToken, error);
    } finally {
      heartbeatController.abort();
      await heartbeatPromise;
    }
  }

  async #executeWithTimeout(
    handler: TaskHandler,
    task: TaskRecord,
    payload: JsonValue,
    abortController: AbortController
  ): Promise<JsonValue | undefined> {
    let timeout: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new TaskExecutionError(
          `Task exceeded its ${String(task.timeoutMs)} ms timeout.`,
          "TASK_TIMEOUT",
          true
        );
        abortController.abort(error);
        reject(error);
      }, task.timeoutMs);
      timeout.unref();
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortListener = (): void => {
        reject(
          abortController.signal.reason instanceof Error
            ? abortController.signal.reason
            : new Error("Task execution was aborted.")
        );
      };
      if (abortController.signal.aborted) {
        abortListener();
      } else {
        abortController.signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    try {
      return await Promise.race([
        handler.execute(
          {
            attempt: task.attempt,
            ...(task.correlationId === undefined ? {} : { correlationId: task.correlationId }),
            signal: abortController.signal,
            taskId: task.id
          },
          payload
        ),
        abortPromise,
        timeoutPromise
      ]);
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      if (abortListener !== undefined) {
        abortController.signal.removeEventListener("abort", abortListener);
      }
    }
  }

  async #heartbeat(
    task: TaskRecord,
    leaseToken: string,
    taskAbortController: AbortController,
    heartbeatController: AbortController
  ): Promise<void> {
    const intervalMs = Math.max(100, Math.floor(this.options.leaseDurationMs / 2));
    while (!heartbeatController.signal.aborted && !taskAbortController.signal.aborted) {
      try {
        await sleep(intervalMs, heartbeatController.signal);
      } catch {
        return;
      }
      try {
        const now = Date.now();
        const renewed = await this.options.store.renewLease(
          task.id,
          leaseToken,
          new Date(now + this.options.leaseDurationMs).toISOString(),
          new Date(now).toISOString()
        );
        if (!renewed) {
          taskAbortController.abort(new TaskLeaseLostError(task.id));
          return;
        }
      } catch (error: unknown) {
        this.options.logger.error({ err: error, taskId: task.id }, "Task lease renewal failed");
        taskAbortController.abort(error);
        return;
      }
    }
  }

  async #handleFailure(task: TaskRecord, leaseToken: string, error: unknown): Promise<void> {
    const failure = taskFailure(error);
    const retry = failure.retryable && task.attempt < task.maxAttempts;
    const nextRunAt = retry ? this.#retryAt(task.attempt) : undefined;

    let failed: TaskRecord;
    try {
      failed = await this.options.store.fail({
        failure,
        leaseToken,
        ...(nextRunAt === undefined ? {} : { nextRunAt }),
        taskId: task.id,
        terminal: !retry,
        updatedAt: new Date().toISOString()
      });
    } catch (storeError: unknown) {
      if (storeError instanceof TaskLeaseLostError) {
        return;
      }
      throw storeError;
    }

    if (retry) {
      await this.#publish("task.retry-scheduled", failed);
      await this.#audit("task.retry", failed, "failure", {
        code: failure.code,
        nextRunAt: failed.runAt
      });
    } else {
      await this.#publish("task.failed", failed);
      await this.#audit("task.fail", failed, "failure", { code: failure.code });
    }
  }

  #retryAt(attempt: number): string {
    const exponential = Math.min(
      this.options.retryMaxDelayMs,
      this.options.retryBaseDelayMs * 2 ** Math.max(0, attempt - 1)
    );
    const jitterRange = exponential * this.options.retryJitter;
    const jitter = (this.#random() * 2 - 1) * jitterRange;
    return new Date(Date.now() + Math.max(0, Math.round(exponential + jitter))).toISOString();
  }

  async #publish(type: keyof TaskEventMap, task: TaskRecord): Promise<void> {
    try {
      const correlation =
        task.correlationId === undefined ? {} : { correlationId: task.correlationId };
      switch (type) {
        case "task.cancelled":
          await this.options.events.publish({
            ...correlation,
            payload: { kind: task.kind, taskId: task.id },
            source: this.name,
            type: "task.cancelled"
          });
          break;
        case "task.completed":
          await this.options.events.publish({
            ...correlation,
            payload: {
              attempt: task.attempt,
              kind: task.kind,
              taskId: task.id
            },
            source: this.name,
            type: "task.completed"
          });
          break;
        case "task.started":
          await this.options.events.publish({
            ...correlation,
            payload: {
              attempt: task.attempt,
              kind: task.kind,
              taskId: task.id
            },
            source: this.name,
            type: "task.started"
          });
          break;
        case "task.failed":
          await this.options.events.publish({
            ...correlation,
            payload: {
              attempt: task.attempt,
              code: task.failure?.code ?? "UNKNOWN",
              kind: task.kind,
              taskId: task.id
            },
            source: this.name,
            type: "task.failed"
          });
          break;
        case "task.retry-scheduled":
          await this.options.events.publish({
            ...correlation,
            payload: {
              attempt: task.attempt,
              kind: task.kind,
              nextRunAt: task.runAt,
              taskId: task.id
            },
            source: this.name,
            type: "task.retry-scheduled"
          });
          break;
        case "task.scheduled":
          await this.options.events.publish({
            ...correlation,
            payload: {
              kind: task.kind,
              runAt: task.runAt,
              taskId: task.id
            },
            source: this.name,
            type: "task.scheduled"
          });
          break;
      }
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error, taskId: task.id, type },
        "Task lifecycle event dispatch failed"
      );
    }
  }

  async #audit(
    action: string,
    task: TaskRecord,
    outcome: "failure" | "success",
    metadata: JsonObject = {}
  ): Promise<void> {
    try {
      await this.options.audit.record({
        action,
        actor: { id: this.options.workerId, kind: "service" },
        ...(task.correlationId === undefined ? {} : { correlationId: task.correlationId }),
        metadata: { kind: task.kind, ...metadata },
        outcome,
        severity: outcome === "success" ? "info" : "warning",
        target: { id: task.id, type: "task" }
      });
    } catch (error: unknown) {
      this.options.logger.error({ err: error, taskId: task.id }, "Task audit write failed");
    }
  }
}
