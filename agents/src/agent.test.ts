import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryEngine } from "@a1/memory";
import { ModelCatalog, ModelManager, type ModelProvider } from "@a1/models";
import {
  PermissionAuthorizer,
  type AuditEnvelope,
  type AuditInput,
  type AuditRecorder
} from "@a1/security";
import { ToolRegistry } from "@a1/tools";
import { afterEach, describe, expect, it } from "vitest";

import { AgentRunner } from "./agent.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("AgentRunner", () => {
  it("executes authorized tools and persists the completed run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-agent-test-"));
    directories.push(directory);
    const memory = new SqliteMemoryEngine({
      busyTimeoutMs: 1_000,
      filePath: join(directory, "memory.sqlite")
    });
    await memory.open();
    let calls = 0;
    const provider: ModelProvider = {
      id: "fake",
      complete: () => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? {
                finishReason: "tool",
                id: "one",
                model: "fake-model",
                providerId: "fake",
                text: "",
                toolCalls: [{ arguments: { text: "hello" }, id: "call-1", name: "echo" }],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
              }
            : {
                finishReason: "stop",
                id: "two",
                model: "fake-model",
                providerId: "fake",
                text: "finished",
                toolCalls: [],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
              }
        );
      },
      embed: () => Promise.reject(new Error("not used")),
      health: () => Promise.resolve(true),
      stream: async function* () {
        await Promise.resolve();
        yield* [];
      }
    };
    const catalog = new ModelCatalog();
    catalog.register({
      capabilities: new Set(["reasoning"]),
      contextWindow: 10_000,
      enabled: true,
      id: "fake-model",
      location: "local",
      maxOutputTokens: 1_000,
      priority: 1,
      providerId: "fake"
    });
    const models = new ModelManager(catalog);
    models.registerProvider(provider);
    const audit: AuditRecorder = {
      record: (input: AuditInput) =>
        Promise.resolve({
          ...input,
          id: "audit",
          metadata: input.metadata ?? {},
          occurredAt: new Date().toISOString()
        } as AuditEnvelope)
    };
    const tools = new ToolRegistry(new PermissionAuthorizer(new Map()), audit);
    tools.register({
      description: "Echo input",
      execute: (_context, input) => Promise.resolve(input),
      inputSchema: { type: "object" },
      name: "echo",
      parse: (input) => input,
      permission: "tool:echo"
    });
    const runner = new AgentRunner(models, memory, tools);
    const result = await runner.run(
      {
        id: "agent-1",
        locationPreference: "local",
        maxSteps: 3,
        modelCapabilities: new Set(["reasoning"]),
        name: "Agent",
        permissions: new Set(["tool:echo"]),
        systemPrompt: "Complete the task."
      },
      "start",
      new AbortController().signal
    );
    const history = await memory.conversation(result.conversationId);
    await memory.close();
    expect(result.output).toBe("finished");
    expect(result.steps).toBe(2);
    expect(history.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "tool",
      "assistant"
    ]);
  });
});
