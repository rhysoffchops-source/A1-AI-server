import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TaskIdempotencyConflictError,
  TaskLeaseLostError,
  type EnqueueTaskInput
} from "@a1/orchestrator";
import { afterEach, describe, expect, it } from "vitest";

import { SqliteTaskStore } from "./sqlite-task-store.js";

const temporaryDirectories: string[] = [];

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-task-store-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "tasks.sqlite");
}

function taskInput(overrides: Partial<EnqueueTaskInput> = {}): EnqueueTaskInput {
  return {
    compareRunAt: true,
    createdAt: "2026-07-28T00:00:00.000Z",
    id: "task-1",
    idempotencyKey: "request-1",
    kind: "test.echo",
    maxAttempts: 3,
    payload: { message: "hello" },
    priority: 0,
    runAt: "2026-07-28T00:00:00.000Z",
    timeoutMs: 1_000,
    ...overrides
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("SqliteTaskStore", () => {
  it("returns the existing task for an identical idempotent enqueue", async () => {
    const store = new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    });
    await store.open();
    const first = await store.enqueue(taskInput());
    const second = await store.enqueue(taskInput({ id: "task-2" }));
    const listed = await store.list(10, "queued");
    await store.close();

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.id).toBe(first.task.id);
    expect(listed).toMatchObject([{ id: first.task.id }]);
  });

  it("rejects an idempotency key reused with different input", async () => {
    const store = new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    });
    await store.open();
    await store.enqueue(taskInput());

    await expect(
      store.enqueue(taskInput({ id: "task-2", payload: { message: "different" } }))
    ).rejects.toBeInstanceOf(TaskIdempotencyConflictError);
    await store.close();
  });

  it("claims a due task only once across concurrent store instances", async () => {
    const filePath = await databasePath();
    const first = new SqliteTaskStore({ busyTimeoutMs: 1_000, filePath });
    const second = new SqliteTaskStore({ busyTimeoutMs: 1_000, filePath });
    await first.open();
    await second.open();
    await first.enqueue(taskInput());

    const firstClaim = await first.claimDue({
      leaseDurationMs: 30_000,
      limit: 1,
      now: "2026-07-28T00:00:01.000Z",
      workerId: "worker-1"
    });
    const secondClaim = await second.claimDue({
      leaseDurationMs: 30_000,
      limit: 1,
      now: "2026-07-28T00:00:01.000Z",
      workerId: "worker-2"
    });
    await second.close();
    await first.close();

    expect(firstClaim).toHaveLength(1);
    expect(secondClaim).toHaveLength(0);
  });

  it("recovers an expired lease without losing the task", async () => {
    const store = new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    });
    await store.open();
    await store.enqueue(taskInput());
    const initial = await store.claimDue({
      leaseDurationMs: 1_000,
      limit: 1,
      now: "2026-07-28T00:00:01.000Z",
      workerId: "worker-1"
    });
    const recovered = await store.claimDue({
      leaseDurationMs: 1_000,
      limit: 1,
      now: "2026-07-28T00:00:03.000Z",
      workerId: "worker-2"
    });
    await store.close();

    expect(initial[0]?.attempt).toBe(1);
    expect(recovered[0]).toMatchObject({
      attempt: 2,
      leaseOwner: "worker-2",
      status: "running"
    });
  });

  it("moves a final expired lease to failed state", async () => {
    const store = new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    });
    await store.open();
    await store.enqueue(taskInput({ maxAttempts: 1 }));
    await store.claimDue({
      leaseDurationMs: 1_000,
      limit: 1,
      now: "2026-07-28T00:00:01.000Z",
      workerId: "worker-1"
    });

    const failed = await store.failExpiredLeases("2026-07-28T00:00:03.000Z");
    await store.close();

    expect(failed[0]).toMatchObject({
      failure: {
        code: "TASK_LEASE_EXPIRED",
        retryable: false
      },
      status: "failed"
    });
  });

  it("rejects completion after the lease expires", async () => {
    const store = new SqliteTaskStore({
      busyTimeoutMs: 1_000,
      filePath: await databasePath()
    });
    await store.open();
    await store.enqueue(taskInput());
    const [claimed] = await store.claimDue({
      leaseDurationMs: 1_000,
      limit: 1,
      now: "2026-07-28T00:00:01.000Z",
      workerId: "worker-1"
    });

    await expect(
      store.complete(
        claimed?.id ?? "",
        claimed?.leaseToken ?? "",
        { completed: true },
        "2026-07-28T00:00:03.000Z"
      )
    ).rejects.toBeInstanceOf(TaskLeaseLostError);
    await store.close();
  });
});
