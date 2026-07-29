import type { HealthCheckResult, JsonObject, LifecycleComponent } from "@a1/core";

import type { McpCallResult, McpClient, McpServerConfig, McpTool } from "./contracts.js";
import { HttpMcpClient } from "./http-client.js";
import { StdioMcpClient } from "./stdio-client.js";

export class McpRegistry implements LifecycleComponent {
  public readonly name = "mcp-registry";
  readonly #clients = new Map<string, McpClient>();
  readonly #started: string[] = [];
  #state: "failed" | "idle" | "running" | "stopped" = "idle";

  public constructor(
    private readonly servers: readonly McpServerConfig[],
    private readonly grantedPermissions: ReadonlySet<string>
  ) {
    if (new Set(servers.map((server) => server.id)).size !== servers.length) {
      throw new Error("MCP server IDs must be unique.");
    }
  }

  public async start(): Promise<void> {
    if (this.#state !== "idle") throw new Error(`MCP registry cannot start from ${this.#state}.`);
    try {
      for (const server of this.servers.filter((item) => item.enabled)) {
        const missing = server.permissions.filter(
          (permission) => !this.grantedPermissions.has(permission)
        );
        if (missing.length > 0) {
          throw new Error(
            `MCP server "${server.id}" is missing permissions: ${missing.join(", ")}.`
          );
        }
        const client: McpClient =
          server.transport === "stdio" ? new StdioMcpClient(server) : new HttpMcpClient(server);
        await client.connect();
        this.#clients.set(server.id, client);
        this.#started.push(server.id);
      }
      this.#state = "running";
    } catch (error: unknown) {
      this.#state = "failed";
      await this.#closeStarted();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    await this.#closeStarted();
    this.#state = "stopped";
  }

  public async listTools(serverId: string): Promise<readonly McpTool[]> {
    return this.#client(serverId).listTools();
  }

  public callTool(
    serverId: string,
    name: string,
    argumentsValue: JsonObject
  ): Promise<McpCallResult> {
    return this.#client(serverId).callTool(name, argumentsValue);
  }

  public health(): HealthCheckResult {
    if (this.#state !== "running") {
      return { message: `MCP registry is ${this.#state}.`, status: "unhealthy" };
    }
    return { status: "healthy" };
  }

  async #closeStarted(): Promise<void> {
    const errors: unknown[] = [];
    while (this.#started.length > 0) {
      const id = this.#started.pop();
      if (id === undefined) break;
      const client = this.#clients.get(id);
      this.#clients.delete(id);
      try {
        await client?.close();
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (errors.length > 0)
      throw new AggregateError(errors, "One or more MCP clients failed to close.");
  }

  #client(serverId: string): McpClient {
    if (this.#state !== "running") throw new Error("MCP registry is not running.");
    const client = this.#clients.get(serverId);
    if (client === undefined) throw new Error(`MCP server "${serverId}" is not connected.`);
    return client;
  }
}
