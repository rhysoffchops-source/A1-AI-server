import type { LifecycleComponent } from "@a1/core";
import type { McpRegistry, McpServerConfig } from "@a1/mcp";
import type { ToolRegistry } from "@a1/tools";

export class McpToolBridge implements LifecycleComponent {
  public readonly name = "mcp-tool-bridge";

  public constructor(
    private readonly configurations: readonly McpServerConfig[],
    private readonly mcp: McpRegistry,
    private readonly tools: ToolRegistry
  ) {}

  public async start(): Promise<void> {
    for (const server of this.configurations.filter((configuration) => configuration.enabled)) {
      const discovered = await this.mcp.listTools(server.id);
      for (const tool of discovered) {
        const name = `mcp.${server.id}.${tool.name}`;
        this.tools.register({
          description: tool.description ?? `Invoke ${tool.name} on MCP server ${server.id}.`,
          execute: async (_context, input) => {
            const result = await this.mcp.callTool(server.id, tool.name, input);
            return { content: result.content, isError: result.isError };
          },
          inputSchema: tool.inputSchema,
          name,
          parse: (input) => input,
          permission: `mcp:${server.id}:tool:${tool.name}`
        });
      }
    }
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }
}
