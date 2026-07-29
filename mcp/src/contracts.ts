import type { JsonObject, JsonValue } from "@a1/core";

export interface McpTool {
  readonly description?: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}
export interface McpCallResult {
  readonly content: readonly JsonValue[];
  readonly isError: boolean;
}
export interface McpClient {
  close(): Promise<void>;
  connect(): Promise<void>;
  listTools(): Promise<readonly McpTool[]>;
  callTool(name: string, argumentsValue: JsonObject): Promise<McpCallResult>;
}
export interface StdioMcpServerConfig {
  readonly args: readonly string[];
  readonly command: string;
  readonly enabled: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly id: string;
  readonly permissions: readonly string[];
  readonly timeoutMs: number;
  readonly transport: "stdio";
}
export interface HttpMcpServerConfig {
  readonly enabled: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly id: string;
  readonly permissions: readonly string[];
  readonly timeoutMs: number;
  readonly transport: "http";
  readonly url: string;
}
export type McpServerConfig = HttpMcpServerConfig | StdioMcpServerConfig;
