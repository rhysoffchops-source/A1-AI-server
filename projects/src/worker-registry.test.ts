import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerRegistry } from "./worker-registry.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("WorkerRegistry", () => {
  it("persists worker heartbeats and executes a durable command queue", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-workers-"));
    directories.push(directory);
    const registry = new WorkerRegistry({
      busyTimeoutMs: 1_000,
      definitions: [
        {
          allowedRoots: ["/Users/dan/Documents"],
          id: "m1",
          name: "Dan's M1",
          platform: "macos"
        }
      ],
      filePath: join(directory, "workers.sqlite")
    });
    await registry.start();
    const worker = await registry.heartbeat("m1", { hostname: "m1.local" });
    const queued = await registry.queue({
      kind: "project.verify",
      payload: { path: "/Users/dan/Documents/A1" },
      workerId: "m1"
    });
    const claimed = await registry.claim("m1");
    expect(worker).toMatchObject({ id: "m1", status: "online" });
    expect(claimed).toMatchObject({ id: queued.id, status: "running" });
    await registry.complete({
      commandId: queued.id,
      result: { exitCode: 0 },
      status: "succeeded",
      workerId: "m1"
    });
    expect(await registry.getCommand("m1", queued.id)).toMatchObject({
      result: { exitCode: 0 },
      status: "succeeded"
    });
    await registry.stop();
  });

  it("requires a new passing verification result after watched code changes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-worker-watch-"));
    directories.push(directory);
    const registry = new WorkerRegistry({
      busyTimeoutMs: 1_000,
      definitions: [
        {
          allowedRoots: ["/workspace"],
          id: "intel",
          name: "Intel workstation",
          platform: "linux"
        }
      ],
      filePath: join(directory, "workers.sqlite")
    });
    await registry.start();
    await registry.heartbeat("intel", {});
    await registry.observeProjects("intel", [
      {
        branch: "main",
        changedFiles: 1,
        fingerprint: "first-fingerprint",
        path: "/workspace/app"
      }
    ]);
    const first = await registry.claim("intel");
    expect(first).toMatchObject({ kind: "project.verify", status: "running" });
    if (first === undefined) throw new Error("Expected first verification command.");
    await registry.complete({
      commandId: first.id,
      result: { exitCode: 0 },
      status: "succeeded",
      workerId: "intel"
    });
    expect(await registry.listProjects("intel")).toMatchObject([
      { fingerprint: "first-fingerprint", verificationStatus: "passed" }
    ]);

    await registry.observeProjects("intel", [
      {
        branch: "main",
        changedFiles: 2,
        fingerprint: "second-fingerprint",
        path: "/workspace/app"
      }
    ]);
    expect(await registry.listProjects("intel")).toMatchObject([
      { fingerprint: "second-fingerprint", verificationStatus: "queued" }
    ]);
    await registry.stop();
  });

  it("defaults to deny writes until the exact fingerprint is reviewed and physically locks a blocked project", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-worker-gate-"));
    directories.push(directory);
    const registry = new WorkerRegistry({
      busyTimeoutMs: 1_000,
      definitions: [
        {
          allowedRoots: ["/workspace"],
          id: "m1",
          name: "Dan's M1",
          platform: "macos"
        }
      ],
      filePath: join(directory, "workers.sqlite")
    });
    await registry.start();
    await registry.heartbeat("m1", {});
    await registry.observeProjects("m1", [
      {
        branch: "main",
        changedFiles: 0,
        fingerprint: "exact-code",
        path: "/workspace/a1-project"
      }
    ]);
    await expect(
      registry.queue({
        kind: "shell",
        payload: { command: "touch should-not-run", cwd: "/workspace/a1-project" },
        workerId: "m1"
      })
    ).rejects.toThrow("not write-authorized");

    const verification = await registry.claim("m1");
    if (verification === undefined) throw new Error("Expected verification command.");
    await registry.complete({
      commandId: verification.id,
      result: { exitCode: 0 },
      status: "succeeded",
      workerId: "m1"
    });
    const decision = await registry.recordReview({
      findings: { violations: ["Unsafe configuration write"] },
      fingerprint: "exact-code",
      path: "/workspace/a1-project",
      status: "blocked",
      summary: "A safe repair is required before this project can continue.",
      workerId: "m1"
    });
    expect(decision.lockCommand).toMatchObject({ kind: "project.lock", status: "queued" });
    expect(decision.project).toMatchObject({ lockStatus: "lock_queued", reviewStatus: "blocked" });

    const lock = await registry.claim("m1");
    if (lock === undefined) throw new Error("Expected project lock command.");
    expect(lock.kind).toBe("project.lock");
    await registry.complete({
      commandId: lock.id,
      result: { manifestPath: "/Users/dan/.a1-worker-locks/project.json" },
      status: "succeeded",
      workerId: "m1"
    });
    expect(await registry.getProject("m1", "/workspace/a1-project")).toMatchObject({
      lockStatus: "locked",
      reviewStatus: "blocked"
    });

    const unlock = await registry.requestProjectUnlock("m1", "/workspace/a1-project");
    expect(unlock).toMatchObject({ kind: "project.unlock", status: "queued" });
    const claimedUnlock = await registry.claim("m1");
    if (claimedUnlock === undefined) throw new Error("Expected project unlock command.");
    await registry.complete({
      commandId: claimedUnlock.id,
      result: { unlocked: true },
      status: "succeeded",
      workerId: "m1"
    });
    expect(await registry.getProject("m1", "/workspace/a1-project")).toMatchObject({
      lockStatus: "unlocked"
    });
    await registry.stop();
  });
});
