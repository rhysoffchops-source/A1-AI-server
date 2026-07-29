import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AuditService } from "./audit.js";
import { ChainedFileAuditSink } from "./chained-file-audit-sink.js";

const temporaryDirectories: string[] = [];

async function auditPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-audit-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "audit.jsonl");
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("ChainedFileAuditSink", () => {
  it("persists and verifies a hash-chained audit log across restarts", async () => {
    const filePath = await auditPath();
    const sink = new ChainedFileAuditSink({ filePath, syncWrites: true });
    const service = new AuditService(sink);
    await service.start();
    await service.record({
      action: "plugin.activate",
      actor: { id: "a1", kind: "system" },
      metadata: { pluginId: "com.a1.test" },
      outcome: "success",
      severity: "info"
    });
    await service.record({
      action: "task.cancel",
      actor: { id: "user-1", kind: "user" },
      outcome: "denied",
      reason: "permission missing",
      severity: "warning"
    });
    await service.stop();

    const reopened = new ChainedFileAuditSink({ filePath, syncWrites: true });
    await expect(reopened.open()).resolves.toBeUndefined();
    await reopened.close();

    const lines = (await readFile(filePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("refuses to open a modified audit chain", async () => {
    const filePath = await auditPath();
    const sink = new ChainedFileAuditSink({ filePath, syncWrites: true });
    const service = new AuditService(sink);
    await service.start();
    await service.record({
      action: "system.start",
      actor: { id: "a1", kind: "system" },
      outcome: "success",
      severity: "info"
    });
    await service.stop();

    const contents = await readFile(filePath, "utf8");
    await writeFile(filePath, contents.replace("system.start", "system.stop"), "utf8");

    const tampered = new ChainedFileAuditSink({ filePath, syncWrites: true });
    await expect(tampered.open()).rejects.toThrow("integrity verification");
  });

  it("prevents two active writers from using the same audit file", async () => {
    const filePath = await auditPath();
    const first = new ChainedFileAuditSink({ filePath, syncWrites: false });
    const second = new ChainedFileAuditSink({ filePath, syncWrites: false });
    await first.open();

    await expect(second.open()).rejects.toThrow("active writer");
    await first.close();
  });
});
