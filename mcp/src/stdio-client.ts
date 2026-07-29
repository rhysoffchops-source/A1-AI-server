import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { JsonObject, JsonValue } from "@a1/core";

import type { McpCallResult, McpClient, McpTool, StdioMcpServerConfig } from "./contracts.js";
import { parseResponse, request, resultObject } from "./json-rpc.js";

interface Pending {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: JsonValue | undefined) => void;
  readonly timer: NodeJS.Timeout;
}

export class StdioMcpClient implements McpClient {
  #child: ChildProcessWithoutNullStreams | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  public constructor(private readonly config: StdioMcpServerConfig) {}

  public async connect(): Promise<void> {
    if (this.#child !== undefined)
      throw new Error(`MCP server "${this.config.id}" is already connected.`);
    const child = spawn(this.config.command, [...this.config.args], {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    this.#child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.#receive(line));
    child.once("exit", (code, signal) => {
      const error = new Error(
        `MCP server "${this.config.id}" exited (${String(code ?? signal ?? "unknown")}).`
      );
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.#pending.clear();
      this.#child = undefined;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    await this.#call("initialize", {
      capabilities: {},
      clientInfo: { name: "a1", version: "0.6.0" },
      protocolVersion: "2025-06-18"
    });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"
    );
  }

  public async close(): Promise<void> {
    const child = this.#child;
    this.#child = undefined;
    if (child === undefined) return;
    child.stdin.end();
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) resolve();
      else child.once("exit", () => resolve());
    });
  }

  public async listTools(): Promise<readonly McpTool[]> {
    const result = resultObject(await this.#call("tools/list"));
    if (!Array.isArray(result.tools)) throw new TypeError("MCP tools/list returned no tools.");
    return result.tools.map((tool) => {
      if (tool === null || typeof tool !== "object" || Array.isArray(tool))
        throw new TypeError("Invalid MCP tool.");
      const record = tool as JsonObject;
      if (
        typeof record.name !== "string" ||
        record.inputSchema === null ||
        typeof record.inputSchema !== "object" ||
        Array.isArray(record.inputSchema)
      ) {
        throw new TypeError("Invalid MCP tool definition.");
      }
      return {
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        inputSchema: record.inputSchema as JsonObject,
        name: record.name
      };
    });
  }

  public async callTool(name: string, argumentsValue: JsonObject): Promise<McpCallResult> {
    const result = resultObject(
      await this.#call("tools/call", { arguments: argumentsValue, name })
    );
    return {
      content: Array.isArray(result.content) ? result.content : [],
      isError: result.isError === true
    };
  }

  #call(method: string, params: JsonObject = {}): Promise<JsonValue | undefined> {
    const child = this.#child;
    if (child === undefined) return Promise.reject(new Error("MCP client is not connected."));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP request "${method}" timed out.`));
      }, this.config.timeoutMs);
      timer.unref();
      this.#pending.set(id, { reject, resolve, timer });
      child.stdin.write(request(id, method, params));
    });
  }

  #receive(line: string): void {
    let response;
    try {
      response = parseResponse(JSON.parse(line) as unknown);
    } catch {
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) return;
    this.#pending.delete(response.id);
    clearTimeout(pending.timer);
    if (response.error !== undefined)
      pending.reject(new Error(`MCP ${String(response.error.code)}: ${response.error.message}`));
    else pending.resolve(response.result);
  }
}
