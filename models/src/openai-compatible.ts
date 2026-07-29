import { randomUUID } from "node:crypto";

import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelDescriptor,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamChunk,
  TokenUsage,
  ToolCall
} from "./contracts.js";
import {
  adapterHeaders,
  type HttpAdapterOptions,
  jsonResponse,
  providerFetch,
  sseEvents
} from "./http.js";

function tokenUsage(value: unknown): TokenUsage {
  const record =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const inputTokens = Number(record.prompt_tokens ?? 0);
  const outputTokens = Number(record.completion_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Number(record.total_tokens ?? inputTokens + outputTokens)
  };
}

function finishReason(value: unknown): ModelResponse["finishReason"] {
  if (value === "length") return "length";
  if (value === "tool_calls" || value === "function_call") return "tool";
  if (value === "content_filter") return "content-filter";
  return "stop";
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function encodeMessages(input: readonly ModelMessage[]): unknown[] {
  return input.map((message) => ({
    ...(message.name === undefined ? {} : { name: message.name }),
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    ...(message.toolCalls === undefined
      ? {}
      : {
          tool_calls: message.toolCalls.map((call) => ({
            function: { arguments: JSON.stringify(call.arguments), name: call.name },
            id: call.id,
            type: "function"
          }))
        }),
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) =>
            part.type === "text"
              ? { text: part.text, type: "text" }
              : { image_url: { url: part.url }, type: "image_url" }
          ),
    role: message.role
  }));
}

function body(request: ModelRequest, model: ModelDescriptor, stream: boolean): object {
  return {
    ...(request.maxTokens === undefined ? {} : { max_tokens: request.maxTokens }),
    messages: encodeMessages(request.messages),
    model: request.model ?? model.id,
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            function: {
              description: tool.description,
              name: tool.name,
              parameters: tool.inputSchema
            },
            type: "function"
          }))
        })
  };
}

function choice(record: Record<string, unknown>): Record<string, unknown> {
  if (
    !Array.isArray(record.choices) ||
    record.choices.length === 0 ||
    record.choices[0] === null ||
    typeof record.choices[0] !== "object"
  ) {
    throw new TypeError("OpenAI-compatible response has no choice.");
  }
  return record.choices[0] as Record<string, unknown>;
}

function toolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (item === null || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (record.function === null || typeof record.function !== "object") return [];
    const fn = record.function as Record<string, unknown>;
    if (typeof fn.name !== "string") return [];
    const parsed =
      typeof fn.arguments === "string" ? (JSON.parse(fn.arguments) as unknown) : fn.arguments;
    const argumentsValue =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    return [
      {
        arguments: argumentsValue as Record<string, never>,
        id: stringField(record.id, randomUUID()),
        name: fn.name
      }
    ];
  });
}

export class OpenAICompatibleProvider implements ModelProvider {
  public readonly id: string;
  public constructor(private readonly options: HttpAdapterOptions) {
    this.id = options.id;
  }

  public async complete(request: ModelRequest, model: ModelDescriptor): Promise<ModelResponse> {
    const record = await this.#post("chat/completions", body(request, model, false));
    const selected = choice(record);
    if (selected.message === null || typeof selected.message !== "object") {
      throw new TypeError("OpenAI-compatible choice has no message.");
    }
    const message = selected.message as Record<string, unknown>;
    return {
      finishReason: finishReason(selected.finish_reason),
      id: stringField(record.id, randomUUID()),
      model: stringField(record.model, model.id),
      providerId: this.id,
      text: typeof message.content === "string" ? message.content : "",
      toolCalls: toolCalls(message.tool_calls),
      usage: tokenUsage(record.usage)
    };
  }

  public async *stream(
    request: ModelRequest,
    model: ModelDescriptor
  ): AsyncIterable<ModelStreamChunk> {
    const response = await providerFetch(this.options, "chat/completions", {
      body: JSON.stringify(body(request, model, true)),
      headers: this.#headers(),
      method: "POST"
    });
    for await (const event of sseEvents(response)) {
      const selected =
        Array.isArray(event.choices) &&
        event.choices[0] !== null &&
        typeof event.choices[0] === "object"
          ? (event.choices[0] as Record<string, unknown>)
          : undefined;
      const delta =
        selected?.delta !== null && typeof selected?.delta === "object"
          ? (selected.delta as Record<string, unknown>)
          : {};
      yield {
        ...(selected?.finish_reason === null || selected?.finish_reason === undefined
          ? {}
          : { finishReason: finishReason(selected.finish_reason) }),
        id: stringField(event.id, randomUUID()),
        model: stringField(event.model, model.id),
        providerId: this.id,
        textDelta: typeof delta.content === "string" ? delta.content : "",
        ...(event.usage === undefined ? {} : { usage: tokenUsage(event.usage) })
      };
    }
  }

  public async embed(
    request: EmbeddingRequest,
    model: ModelDescriptor
  ): Promise<EmbeddingResponse> {
    const record = await this.#post("embeddings", {
      input: request.input,
      model: request.model ?? model.id
    });
    if (!Array.isArray(record.data)) throw new TypeError("Embedding response has no data array.");
    const embeddings = record.data.map((item) => {
      if (
        item === null ||
        typeof item !== "object" ||
        !Array.isArray((item as Record<string, unknown>).embedding)
      ) {
        throw new TypeError("Embedding response contains an invalid vector.");
      }
      return ((item as Record<string, unknown>).embedding as unknown[]).map(Number);
    });
    return {
      dimensions: embeddings[0]?.length ?? 0,
      embeddings,
      model: stringField(record.model, model.id),
      providerId: this.id,
      usage: tokenUsage(record.usage)
    };
  }

  public async health(): Promise<boolean> {
    try {
      await providerFetch(this.options, "models", { headers: this.#headers(), method: "GET" });
      return true;
    } catch {
      return false;
    }
  }

  async #post(path: string, value: object): Promise<Record<string, unknown>> {
    return jsonResponse(
      await providerFetch(this.options, path, {
        body: JSON.stringify(value),
        headers: this.#headers(),
        method: "POST"
      })
    );
  }

  #headers(): Record<string, string> {
    return adapterHeaders(
      this.options,
      this.options.apiKey === undefined ? {} : { authorization: `Bearer ${this.options.apiKey}` }
    );
  }
}
