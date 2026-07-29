import { randomUUID } from "node:crypto";

import type { MemoryEngine } from "@a1/memory";
import type { ModelCapability, ModelManager, ModelMessage, ModelTool } from "@a1/models";
import type { Principal } from "@a1/security";
import type { ToolRegistry } from "@a1/tools";

export interface AgentDefinition {
  readonly id: string;
  readonly locationPreference: "any" | "cloud" | "local";
  readonly maxSteps: number;
  readonly modelCapabilities: ReadonlySet<ModelCapability>;
  readonly name: string;
  readonly permissions: ReadonlySet<string>;
  readonly systemPrompt: string;
}
export interface AgentRunResult {
  readonly agentId: string;
  readonly conversationId: string;
  readonly output: string;
  readonly runId: string;
  readonly steps: number;
}

export class AgentRunner {
  public constructor(
    private readonly models: ModelManager,
    private readonly memory: MemoryEngine,
    private readonly tools: ToolRegistry
  ) {}

  public async run(
    definition: AgentDefinition,
    input: string,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    if (!Number.isSafeInteger(definition.maxSteps) || definition.maxSteps <= 0) {
      throw new RangeError("Agent maxSteps must be positive.");
    }
    const runId = randomUUID();
    const conversationId = `agent:${definition.id}:${runId}`;
    const principal: Principal = {
      id: definition.id,
      permissions: new Set(definition.permissions),
      roles: new Set(["agent"])
    };
    const messages: ModelMessage[] = [
      { content: definition.systemPrompt, role: "system" },
      { content: input, role: "user" }
    ];
    await this.memory.addMessage(conversationId, "system", definition.systemPrompt);
    await this.memory.addMessage(conversationId, "user", input);

    for (let step = 1; step <= definition.maxSteps; step += 1) {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error("Agent run cancelled.");
      const descriptors = this.tools.list(principal);
      const modelTools: ModelTool[] = descriptors.map((tool) => ({
        description: tool.description,
        inputSchema: tool.inputSchema,
        name: tool.name
      }));
      const response = await this.models.complete(
        {
          capabilities: definition.modelCapabilities,
          locationPreference: definition.locationPreference
        },
        { messages, tools: modelTools }
      );
      messages.push({
        content: response.text,
        role: "assistant",
        ...(response.toolCalls.length === 0 ? {} : { toolCalls: response.toolCalls })
      });
      const persistedResponse =
        response.text.trim() === ""
          ? JSON.stringify({ toolCalls: response.toolCalls })
          : response.text;
      await this.memory.addMessage(conversationId, "assistant", persistedResponse, {
        model: response.model,
        providerId: response.providerId,
        step
      });
      if (response.toolCalls.length === 0) {
        await this.memory.remember({
          content: response.text,
          key: runId,
          metadata: { conversationId, steps: step },
          scope: "agent",
          scopeId: definition.id
        });
        return {
          agentId: definition.id,
          conversationId,
          output: response.text,
          runId,
          steps: step
        };
      }
      for (const call of response.toolCalls) {
        const result = await this.tools.invoke(principal, call.name, call.arguments, signal);
        const content = JSON.stringify(result);
        messages.push({ content, name: call.name, role: "tool", toolCallId: call.id });
        await this.memory.addMessage(conversationId, "tool", content, {
          name: call.name,
          toolCallId: call.id
        });
      }
    }
    throw new Error(`Agent "${definition.id}" exceeded ${String(definition.maxSteps)} steps.`);
  }
}
