import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BackupService, FileBackupSource, FileRestoreTarget } from "./backup.js";
import { LocalObjectStorage } from "./object-storage.js";

const directories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-storage-test-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("LocalObjectStorage", () => {
  it("atomically stores, retrieves, lists, and deletes objects", async () => {
    const storage = new LocalObjectStorage(await temporaryDirectory());
    await storage.put({
      body: new TextEncoder().encode("hello"),
      contentType: "text/plain",
      key: "projects/one.txt",
      metadata: { owner: "a1" }
    });
    expect(new TextDecoder().decode((await storage.get("projects/one.txt"))?.body)).toBe("hello");
    expect(await storage.list("projects")).toMatchObject([{ key: "projects/one.txt", size: 5 }]);
    await storage.delete("projects/one.txt");
    expect(await storage.get("projects/one.txt")).toBeUndefined();
  });

  it("creates and restores an integrity-checked backup", async () => {
    const directory = await temporaryDirectory();
    const source = join(directory, "source.txt");
    const restored = join(directory, "restored.txt");
    await writeFile(source, "durable data", "utf8");
    const service = new BackupService(new LocalObjectStorage(join(directory, "objects")));
    const manifest = await service.create([new FileBackupSource("database", source)]);
    expect(await service.list()).toMatchObject([{ id: manifest.id }]);
    await service.restore(manifest.id, [new FileRestoreTarget("database", restored)]);
    expect(await readFile(restored, "utf8")).toBe("durable data");
  });
});
