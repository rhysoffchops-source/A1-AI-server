import type { JsonObject, JsonValue } from "@a1/core";

import type { HttpMcpServerConfig, McpCallResult, McpClient, McpTool } from "./contracts.js";
import { parseResponse, resultObject } from "./json-rpc.js";

export class HttpMcpClient implements McpClient {
  #nextId = 1;
  #sessionId: string | undefined;
  public constructor(private readonly config: HttpMcpServerConfig) {}
  public async connect(): Promise<void> {
    await this.#call("initialize", {
      capabilities: {},
      clientInfo: { name: "a1", version: "0.6.0" },
      protocolVersion: "2025-06-18"
    });
    await this.#notify("notifications/initialized");
  }
  public async close(): Promise<void> {
    await Promise.resolve();
    this.#sessionId = undefined;
  }
  public async listTools(): Promise<readonly McpTool[]> {
    const result = resultObject(await this.#call("tools/list"));
    if (!Array.isArray(result.tools)) throw new TypeError("MCP tools/list returned no tools.");
    return result.tools.map((item) => {
      if (item === null || typeof item !== "object" || Array.isArray(item))
        throw new TypeError("Invalid MCP tool.");
      const tool = item as JsonObject;
      if (
        typeof tool.name !== "string" ||
        tool.inputSchema === null ||
        typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema)
      ) {
        throw new TypeError("Invalid MCP tool definition.");
      }
      return {
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema as JsonObject,
        name: tool.name
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
  async #notify(method: string): Promise<void> {
    await this.#fetch({ jsonrpc: "2.0", method });
  }
  async #call(method: string, params: JsonObject = {}): Promise<JsonValue | undefined> {
    const id = this.#nextId++;
    const response = parseResponse(await this.#fetch({ id, jsonrpc: "2.0", method, params }));
    if (response.error !== undefined)
      throw new Error(`MCP ${String(response.error.code)}: ${response.error.message}`);
    return response.result;
  }
  async #fetch(body: object): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    timer.unref();
    try {
      const response = await fetch(this.config.url, {
        body: JSON.stringify(body),
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...this.config.headers,
          ...(this.#sessionId === undefined ? {} : { "mcp-session-id": this.#sessionId })
        },
        method: "POST",
        signal: controller.signal
      });
      if (!response.ok)
        throw new Error(
          `MCP HTTP ${String(response.status)}: ${(await response.text()).slice(0, 1000)}`
        );
      this.#sessionId = response.headers.get("mcp-session-id") ?? this.#sessionId;
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        const text = await response.text();
        const data = text.split("\n").findLast((line) => line.startsWith("data:"));
        if (data === undefined) return {};
        return JSON.parse(data.slice(5).trim()) as unknown;
      }
      const text = await response.text();
      return text === "" ? {} : (JSON.parse(text) as unknown);
    } finally {
      clearTimeout(timer);
    }
  }
}
