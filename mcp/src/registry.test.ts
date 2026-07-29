import { describe, expect, it } from "vitest";

import { McpRegistry } from "./registry.js";

const fakeServer = `
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === "tools/list"
    ? { tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object" } }] }
    : message.method === "tools/call"
      ? { content: [{ type: "text", text: message.params.arguments.text }], isError: false }
      : { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`;

describe("McpRegistry", () => {
  it("starts a configured stdio server and invokes its tool", async () => {
    const registry = new McpRegistry(
      [
        {
          args: ["-e", fakeServer],
          command: process.execPath,
          enabled: true,
          env: {},
          id: "fake",
          permissions: ["test.echo"],
          timeoutMs: 2_000,
          transport: "stdio"
        }
      ],
      new Set(["test.echo"])
    );
    await registry.start();
    expect((await registry.listTools("fake"))[0]?.name).toBe("echo");
    expect(await registry.callTool("fake", "echo", { text: "hello" })).toMatchObject({
      content: [{ text: "hello", type: "text" }],
      isError: false
    });
    await registry.stop();
  });

  it("fails closed when permissions are missing", async () => {
    const registry = new McpRegistry(
      [
        {
          args: [],
          command: "unused",
          enabled: true,
          env: {},
          id: "restricted",
          permissions: ["filesystem.write"],
          timeoutMs: 1_000,
          transport: "stdio"
        }
      ],
      new Set()
    );
    await expect(registry.start()).rejects.toThrow("missing permissions");
  });
});
