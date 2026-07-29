import { randomUUID } from "node:crypto";

import { assertJsonValue, type JsonObject } from "@a1/core";

import type {
  EmbeddingRequest,
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

function parts(content: ModelMessage["content"]): unknown[] {
  if (typeof content === "string") return [{ text: content }];
  return content.map((part) => {
    if (part.type === "text") return { text: part.text };
    const data = /^data:([^;,]+);base64,(.+)$/u.exec(part.url);
    return data === null
      ? { fileData: { fileUri: part.url, mimeType: part.mediaType ?? "image/*" } }
      : { inlineData: { data: data[2], mimeType: data[1] } };
  });
}

function parseToolContent(content: ModelMessage["content"]): unknown {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { content: text };
  }
}

function messageParts(message: ModelMessage): unknown[] {
  const encoded = parts(message.content);
  if (message.role === "assistant" && message.toolCalls !== undefined) {
    encoded.push(
      ...message.toolCalls.map((call) => ({
        functionCall: { args: call.arguments, name: call.name }
      }))
    );
  }
  if (message.role === "tool") {
    return [
      {
        functionResponse: {
          name: message.name ?? message.toolCallId ?? "tool",
          response: parseToolContent(message.content)
        }
      }
    ];
  }
  return encoded;
}

function requestBody(request: ModelRequest): object {
  const system = request.messages.filter((message) => message.role === "system");
  return {
    contents: request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        parts: messageParts(message),
        role: message.role === "assistant" ? "model" : "user"
      })),
    generationConfig: {
      ...(request.maxTokens === undefined ? {} : { maxOutputTokens: request.maxTokens }),
      ...(request.stop === undefined ? {} : { stopSequences: request.stop }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature })
    },
    ...(system.length === 0
      ? {}
      : {
          systemInstruction: {
            parts: system.flatMap((message) => parts(message.content))
          }
        }),
    ...(request.tools === undefined
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                description: tool.description,
                name: tool.name,
                parameters: tool.inputSchema
              }))
            }
          ]
        })
  };
}

function candidate(record: Record<string, unknown>): Record<string, unknown> {
  if (
    !Array.isArray(record.candidates) ||
    record.candidates[0] === null ||
    typeof record.candidates[0] !== "object"
  ) {
    throw new TypeError("Gemini response has no candidate.");
  }
  return record.candidates[0] as Record<string, unknown>;
}

function textFromCandidate(value: Record<string, unknown>): string {
  const content =
    value.content !== null && typeof value.content === "object"
      ? (value.content as Record<string, unknown>)
      : {};
  return Array.isArray(content.parts)
    ? content.parts
        .filter((part) => part !== null && typeof part === "object")
        .map((part) =>
          typeof (part as Record<string, unknown>).text === "string"
            ? String((part as Record<string, unknown>).text)
            : ""
        )
        .join("")
    : "";
}

function toolCallsFromCandidate(value: Record<string, unknown>): ToolCall[] {
  const content =
    value.content !== null && typeof value.content === "object"
      ? (value.content as Record<string, unknown>)
      : {};
  if (!Array.isArray(content.parts)) return [];
  return content.parts.flatMap((part): ToolCall[] => {
    if (part === null || typeof part !== "object") return [];
    const functionCall = (part as Record<string, unknown>).functionCall;
    if (functionCall === null || typeof functionCall !== "object") return [];
    const record = functionCall as Record<string, unknown>;
    if (typeof record.name !== "string") return [];
    const argumentsValue: unknown =
      record.args !== null && typeof record.args === "object" ? record.args : {};
    assertJsonValue(argumentsValue, "Gemini function arguments");
    if (
      argumentsValue === null ||
      typeof argumentsValue !== "object" ||
      Array.isArray(argumentsValue)
    ) {
      throw new TypeError("Gemini function arguments must be a JSON object.");
    }
    return [{ arguments: argumentsValue as JsonObject, id: randomUUID(), name: record.name }];
  });
}

export class GeminiProvider implements ModelProvider {
  public readonly id: string;
  public constructor(private readonly options: HttpAdapterOptions) {
    this.id = options.id;
  }

  public async complete(request: ModelRequest, model: ModelDescriptor): Promise<ModelResponse> {
    const record = await this.#post(
      `models/${encodeURIComponent(request.model ?? model.id)}:generateContent${this.#keyQuery()}`,
      requestBody(request)
    );
    const selected = candidate(record);
    const usage =
      record.usageMetadata !== null && typeof record.usageMetadata === "object"
        ? (record.usageMetadata as Record<string, unknown>)
        : {};
    const inputTokens = Number(usage.promptTokenCount ?? 0);
    const outputTokens = Number(usage.candidatesTokenCount ?? 0);
    const toolCalls = toolCallsFromCandidate(selected);
    return {
      finishReason:
        selected.finishReason === "MAX_TOKENS" ? "length" : toolCalls.length > 0 ? "tool" : "stop",
      id: randomUUID(),
      model: request.model ?? model.id,
      providerId: this.id,
      text: textFromCandidate(selected),
      toolCalls,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: Number(usage.totalTokenCount ?? inputTokens + outputTokens)
      }
    };
  }

  public async *stream(
    request: ModelRequest,
    model: ModelDescriptor
  ): AsyncIterable<ModelStreamChunk> {
    const response = await providerFetch(
      this.options,
      `models/${encodeURIComponent(request.model ?? model.id)}:streamGenerateContent${this.#keyQuery("&alt=sse")}`,
      {
        body: JSON.stringify(requestBody(request)),
        headers: adapterHeaders(this.options),
        method: "POST"
      }
    );
    const id = randomUUID();
    for await (const event of sseEvents(response)) {
      yield {
        id,
        model: request.model ?? model.id,
        providerId: this.id,
        textDelta: textFromCandidate(candidate(event))
      };
    }
  }

  public async embed(
    request: EmbeddingRequest,
    model: ModelDescriptor
  ): Promise<EmbeddingResponse> {
    const modelId = request.model ?? model.id;
    const record = await this.#post(
      `models/${encodeURIComponent(modelId)}:batchEmbedContents${this.#keyQuery()}`,
      {
        requests: request.input.map((content) => ({
          content: { parts: [{ text: content }] },
          model: `models/${modelId}`
        }))
      }
    );
    if (!Array.isArray(record.embeddings))
      throw new TypeError("Gemini response has no embeddings.");
    const embeddings = record.embeddings.map((embedding) => {
      if (
        embedding === null ||
        typeof embedding !== "object" ||
        !Array.isArray((embedding as Record<string, unknown>).values)
      ) {
        throw new TypeError("Gemini returned an invalid embedding.");
      }
      return ((embedding as Record<string, unknown>).values as unknown[]).map(Number);
    });
    return {
      dimensions: embeddings[0]?.length ?? 0,
      embeddings,
      model: modelId,
      providerId: this.id,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    };
  }

  public async health(): Promise<boolean> {
    try {
      await providerFetch(this.options, `models?pageSize=1${this.#keyQuery("&")}`, {
        headers: adapterHeaders(this.options),
        method: "GET"
      });
      return true;
    } catch {
      return false;
    }
  }

  async #post(path: string, value: object): Promise<Record<string, unknown>> {
    return jsonResponse(
      await providerFetch(this.options, path, {
        body: JSON.stringify(value),
        headers: adapterHeaders(this.options),
        method: "POST"
      })
    );
  }

  #keyQuery(suffix = ""): string {
    return `${this.options.apiKey === undefined ? "?" : `?key=${encodeURIComponent(this.options.apiKey)}`}${suffix}`;
  }
}
