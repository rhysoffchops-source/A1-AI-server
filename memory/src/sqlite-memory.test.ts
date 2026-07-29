import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteMemoryEngine } from "./sqlite-memory.js";

const directories: string[] = [];
async function databasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-memory-test-"));
  directories.push(directory);
  return join(directory, "memory.sqlite");
}
async function engine(filePath?: string): Promise<SqliteMemoryEngine> {
  const resolvedPath = filePath ?? (await databasePath());
  const memory = new SqliteMemoryEngine({ busyTimeoutMs: 1_000, filePath: resolvedPath });
  await memory.open();
  return memory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("SqliteMemoryEngine", () => {
  it("persists ordered conversation memory across restarts", async () => {
    const filePath = await databasePath();
    const first = await engine(filePath);
    await first.addMessage("conversation-1", "user", "hello");
    await first.addMessage("conversation-1", "assistant", "hi");
    await first.close();

    const second = await engine(filePath);
    const messages = await second.conversation("conversation-1");
    await second.close();

    expect(messages.map((message) => message.content)).toEqual(["hello", "hi"]);
  });

  it("searches scoped semantic vectors and full text", async () => {
    const memory = await engine();
    await memory.remember({
      content: "A1 uses interchangeable model providers",
      embedding: [1, 0],
      key: "architecture",
      scope: "project",
      scopeId: "a1"
    });
    await memory.remember({
      content: "unrelated personal note",
      embedding: [0, 1],
      key: "other",
      scope: "global",
      scopeId: "default"
    });
    const results = await memory.search({
      embedding: [0.9, 0.1],
      limit: 5,
      scopes: [{ scope: "project", scopeId: "a1" }]
    });
    const textResults = await memory.search({ limit: 5, query: "model providers" });
    await memory.close();
    expect(results[0]?.record.key).toBe("architecture");
    expect(textResults[0]?.record.key).toBe("architecture");
  });

  it("stores and traverses knowledge graph edges", async () => {
    const memory = await engine();
    await memory.upsertEntity({ id: "a1", kind: "project", metadata: {}, name: "A1" });
    await memory.upsertEntity({ id: "model", kind: "system", metadata: {}, name: "Models" });
    await memory.connect({ fromId: "a1", metadata: {}, relation: "contains", toId: "model" });
    const edges = await memory.neighbors("a1", "contains");
    await memory.close();
    expect(edges).toMatchObject([{ fromId: "a1", relation: "contains", toId: "model" }]);
  });
});
