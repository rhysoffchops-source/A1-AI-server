import { assertJsonValue, type JsonObject, type JsonValue } from "@a1/core";
import type { AuditRecorder, PermissionAuthorizer, Principal } from "@a1/security";

export interface ToolContext {
  readonly principal: Principal;
  readonly signal: AbortSignal;
}
export interface Tool {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
  readonly permission: string;
  execute(context: ToolContext, input: JsonObject): Promise<JsonValue>;
  parse(input: JsonObject): JsonObject;
}
export interface ToolDescriptor {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}

export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  public constructor(
    private readonly authorizer: PermissionAuthorizer,
    private readonly audit: AuditRecorder
  ) {}

  public register(tool: Tool): void {
    if (this.#tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered.`);
    if (tool.name.trim() === "" || tool.permission.trim() === "")
      throw new TypeError("Tool name and permission are required.");
    this.#tools.set(tool.name, tool);
  }

  public list(principal: Principal): readonly ToolDescriptor[] {
    return [...this.#tools.values()]
      .filter((tool) => this.authorizer.allows(principal, tool.permission))
      .map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  public async invoke(
    principal: Principal,
    name: string,
    input: JsonObject,
    signal: AbortSignal
  ): Promise<JsonValue> {
    const tool = this.#tools.get(name);
    if (tool === undefined) throw new Error(`Tool "${name}" is not registered.`);
    this.authorizer.require(principal, tool.permission);
    const parsed = tool.parse(input);
    assertJsonValue(parsed);
    try {
      const result = await tool.execute({ principal, signal }, parsed);
      assertJsonValue(result, "tool result");
      await this.audit.record({
        action: "tool.invoke",
        actor: { id: principal.id, kind: "agent" },
        metadata: { name, permission: tool.permission },
        outcome: "success",
        severity: "info",
        target: { id: name, type: "tool" }
      });
      return result;
    } catch (error: unknown) {
      await this.audit
        .record({
          action: "tool.invoke",
          actor: { id: principal.id, kind: "agent" },
          metadata: { name, permission: tool.permission },
          outcome: "failure",
          reason: error instanceof Error ? error.message : "Tool failed.",
          severity: "warning",
          target: { id: name, type: "tool" }
        })
        .catch(() => undefined);
      throw error;
    }
  }
}
