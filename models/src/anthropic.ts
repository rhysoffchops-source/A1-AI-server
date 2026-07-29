import { randomUUID } from "node:crypto";

import type {
  EmbeddingResponse,
  ModelDescriptor,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  ToolCall
} from "./contracts.js";
import {
  adapterHeaders,
  type HttpAdapterOptions,
  jsonResponse,
  providerFetch,
  sseEvents
} from "./http.js";

export interface AnthropicProviderOptions extends HttpAdapterOptions {
  readonly apiVersion?: string;
}

function text(content: ModelMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function encodeContent(content: ModelMessage["content"]): unknown {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") return { text: part.text, type: "text" };
    if (part.url.startsWith("data:")) {
      const match = /^data:([^;,]+);base64,(.+)$/u.exec(part.url);
      if (match !== null) {
        return {
          source: { data: match[2], media_type: match[1], type: "base64" },
          type: "image"
        };
      }
    }
    return { source: { type: "url", url: part.url }, type: "image" };
  });
}

function body(request: ModelRequest, model: ModelDescriptor, stream: boolean): object {
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => text(message.content))
    .join("\n\n");
  return {
    max_tokens: request.maxTokens ?? model.maxOutputTokens,
    messages: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        content:
          message.role === "tool"
            ? [
                {
                  content: text(message.content),
                  tool_use_id: message.toolCallId,
                  type: "tool_result"
                }
              ]
            : message.toolCalls === undefined
              ? encodeContent(message.content)
              : [
                  ...(Array.isArray(encodeContent(message.content))
                    ? (encodeContent(message.content) as unknown[])
                    : [{ text: encodeContent(message.content), type: "text" }]),
                  ...message.toolCalls.map((call) => ({
                    id: call.id,
                    input: call.arguments,
                    name: call.name,
                    type: "tool_use"
                  }))
                ],
        role: message.role === "assistant" ? "assistant" : "user"
      })),
    model: request.model ?? model.id,
    ...(request.stop === undefined ? {} : { stop_sequences: request.stop }),
    stream,
    ...(system.length === 0 ? {} : { system }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            description: tool.description,
            input_schema: tool.inputSchema,
            name: tool.name
          }))
        })
  };
}

function parseContent(value: unknown): { text: string; toolCalls: ToolCall[] } {
  if (!Array.isArray(value)) return { text: "", toolCalls: [] };
  const output: string[] = [];
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") output.push(record.text);
    if (
      record.type === "tool_use" &&
      typeof record.name === "string" &&
      record.input !== null &&
      typeof record.input === "object" &&
      !Array.isArray(record.input)
    ) {
      calls.push({
        arguments: record.input as Record<string, never>,
        id: stringField(record.id, randomUUID()),
        name: record.name
      });
    }
  }
  return { text: output.join(""), toolCalls: calls };
}

export class AnthropicProvider implements ModelProvider {
  public readonly id: string;
  public constructor(private readonly options: AnthropicProviderOptions) {
    this.id = options.id;
  }

  public async complete(request: ModelRequest, model: ModelDescriptor): Promise<ModelResponse> {
    const record = await jsonResponse(
      await providerFetch(this.options, "messages", {
        body: JSON.stringify(body(request, model, false)),
        headers: this.#headers(),
        method: "POST"
      })
    );
    const content = parseContent(record.content);
    const usage =
      record.usage !== null && typeof record.usage === "object"
        ? (record.usage as Record<string, unknown>)
        : {};
    const inputTokens = Number(usage.input_tokens ?? 0);
    const outputTokens = Number(usage.output_tokens ?? 0);
    return {
      finishReason:
        record.stop_reason === "max_tokens"
          ? "length"
          : content.toolCalls.length > 0
            ? "tool"
            : "stop",
      id: stringField(record.id, randomUUID()),
      model: stringField(record.model, model.id),
      providerId: this.id,
      text: content.text,
      toolCalls: content.toolCalls,
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
    };
  }

  public async *stream(
    request: ModelRequest,
    model: ModelDescriptor
  ): AsyncIterable<ModelStreamChunk> {
    const response = await providerFetch(this.options, "messages", {
      body: JSON.stringify(body(request, model, true)),
      headers: this.#headers(),
      method: "POST"
    });
    const id = randomUUID();
    for await (const event of sseEvents(response)) {
      const delta =
        event.delta !== null && typeof event.delta === "object"
          ? (event.delta as Record<string, unknown>)
          : {};
      if (typeof delta.text === "string") {
        yield {
          id: stringField(event.message_id, id),
          model: request.model ?? model.id,
          providerId: this.id,
          textDelta: delta.text
        };
      }
    }
  }

  public embed(): Promise<EmbeddingResponse> {
    return Promise.reject(
      new Error(
        "Anthropic does not expose a native embedding endpoint; route embeddings elsewhere."
      )
    );
  }

  public async health(): Promise<boolean> {
    try {
      await providerFetch(this.options, "models?limit=1", {
        headers: this.#headers(),
        method: "GET"
      });
      return true;
    } catch {
      return false;
    }
  }

  #headers(): Record<string, string> {
    return adapterHeaders(this.options, {
      "anthropic-version": this.options.apiVersion ?? "2023-06-01",
      ...(this.options.apiKey === undefined ? {} : { "x-api-key": this.options.apiKey })
    });
  }
}
