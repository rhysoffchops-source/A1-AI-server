import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createLogger, InMemoryEventBus, type JsonObject, type JsonValue } from "@a1/core";
import { SqliteTaskStore } from "@a1/databases";
import { TaskScheduler, type TaskEventMap, type TaskHandler } from "@a1/orchestrator";
import type { AuditEnvelope, AuditInput, AuditRecorder } from "@a1/security";
import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-scheduler-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "tasks.sqlite");
}

function auditRecorder(): AuditRecorder {
  return {
    record: (input: AuditInput) =>
      Promise.resolve({
        ...input,
        id: randomUUID(),
        metadata: input.metadata ?? {},
        occurredAt: new Date().toISOString()
      } as AuditEnvelope)
  };
}

async function scheduler(
  events: InMemoryEventBus<TaskEventMap>,
  handler: TaskHandler
): Promise<TaskScheduler> {
  const taskScheduler = new TaskScheduler({
    audit: auditRecorder(),
    claimBatchSize: 4,
    defaultMaxAttempts: 3,
    defaultTaskTimeoutMs: 1_000,
    events,
    leaseDurationMs: 1_000,
    logger: createLogger({
      environment: "test",
      level: "fatal",
      serviceName: "scheduler-test",
      version: "0.2.0"
    }),
    maxConcurrency: 2,
    pollIntervalMs: 5,
    random: () => 0.5,
    retryBaseDelayMs: 5,
    retryJitter: 0,
    retryMaxDelayMs: 20,
    store: new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    }),
    workerId: "test-worker"
  });
  taskScheduler.registerHandler(handler);
  await taskScheduler.start();
  return taskScheduler;
}

function waitForEvent(
  events: InMemoryEventBus<TaskEventMap>,
  type: keyof TaskEventMap
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${type}.`));
    }, 2_000);
    const unsubscribe = events.subscribe(type, () => {
      clearTimeout(timeout);
      unsubscribe();
      resolve();
    });
  });
}

function objectPayload(payload: JsonValue): JsonObject {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new TypeError("Expected an object payload.");
  }
  return payload;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("TaskScheduler", () => {
  it("persists, claims, executes, and completes a task", async () => {
    const events = new InMemoryEventBus<TaskEventMap>();
    const completion = waitForEvent(events, "task.completed");
    const taskScheduler = await scheduler(events, {
      execute: (_context, payload) => Promise.resolve(payload),
      kind: "test.echo",
      parse: objectPayload
    });

    const scheduled = await taskScheduler.schedule({
      kind: "test.echo",
      payload: { message: "hello" }
    });
    await completion;
    const completed = await taskScheduler.get(scheduled.id);
    await taskScheduler.stop();

    expect(completed).toMatchObject({
      attempt: 1,
      result: { message: "hello" },
      status: "succeeded"
    });
  });

  it("retries a retryable failure and preserves attempt count", async () => {
    const events = new InMemoryEventBus<TaskEventMap>();
    const completion = waitForEvent(events, "task.completed");
    let executions = 0;
    const taskScheduler = await scheduler(events, {
      execute: (_context, payload) => {
        executions += 1;
        return executions === 1
          ? Promise.reject(new Error("transient failure"))
          : Promise.resolve(payload);
      },
      kind: "test.retry",
      parse: objectPayload
    });

    const scheduled = await taskScheduler.schedule({
      kind: "test.retry",
      maxAttempts: 3,
      payload: { retry: true }
    });
    await completion;
    const completed = await taskScheduler.get(scheduled.id);
    await taskScheduler.stop();

    expect(executions).toBe(2);
    expect(completed).toMatchObject({
      attempt: 2,
      status: "succeeded"
    });
  });

  it("cancels a queued future task durably", async () => {
    const events = new InMemoryEventBus<TaskEventMap>();
    const taskScheduler = await scheduler(events, {
      execute: (_context, payload) => Promise.resolve(payload),
      kind: "test.future",
      parse: objectPayload
    });
    const scheduled = await taskScheduler.schedule({
      kind: "test.future",
      payload: {},
      runAt: new Date(Date.now() + 60_000)
    });

    const cancelled = await taskScheduler.cancel(scheduled.id);
    await taskScheduler.stop();

    expect(cancelled?.status).toBe("cancelled");
  });

  it("deduplicates an immediate task by idempotency key", async () => {
    const events = new InMemoryEventBus<TaskEventMap>();
    const scheduledEvents = vi.fn();
    events.subscribe("task.scheduled", scheduledEvents);
    const taskScheduler = await scheduler(events, {
      execute: (_context, payload) => Promise.resolve(payload),
      kind: "test.idempotent",
      parse: objectPayload
    });

    const first = await taskScheduler.schedule({
      idempotencyKey: "request-1",
      kind: "test.idempotent",
      payload: { value: 1 }
    });
    const second = await taskScheduler.schedule({
      idempotencyKey: "request-1",
      kind: "test.idempotent",
      payload: { value: 1 }
    });
    await taskScheduler.stop();

    expect(second.id).toBe(first.id);
    expect(scheduledEvents).toHaveBeenCalledOnce();
  });
});
