import type { JsonObject } from "@a1/core";

export type ModelCapability =
  "coding" | "embedding" | "fast" | "long-context" | "reasoning" | "uncensored" | "vision";
export type ModelLocation = "cloud" | "local";
export type MessageRole = "assistant" | "system" | "tool" | "user";

export interface TextContent {
  readonly text: string;
  readonly type: "text";
}
export interface ImageContent {
  readonly mediaType?: string;
  readonly type: "image";
  readonly url: string;
}
export type MessageContent = string | readonly (ImageContent | TextContent)[];
export interface ModelMessage {
  readonly content: MessageContent;
  readonly name?: string;
  readonly role: MessageRole;
  readonly toolCalls?: readonly ToolCall[];
  readonly toolCallId?: string;
}
export interface ModelTool {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}
export interface ModelRequest {
  readonly maxTokens?: number;
  readonly messages: readonly ModelMessage[];
  readonly metadata?: JsonObject;
  readonly model?: string;
  readonly stop?: readonly string[];
  readonly temperature?: number;
  readonly tools?: readonly ModelTool[];
}
export interface ToolCall {
  readonly arguments: JsonObject;
  readonly id: string;
  readonly name: string;
}
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}
export interface ModelResponse {
  readonly finishReason: "content-filter" | "error" | "length" | "stop" | "tool";
  readonly id: string;
  readonly model: string;
  readonly providerId: string;
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly usage: TokenUsage;
}
export interface ModelStreamChunk {
  readonly finishReason?: ModelResponse["finishReason"];
  readonly id: string;
  readonly model: string;
  readonly providerId: string;
  readonly textDelta: string;
  readonly usage?: TokenUsage;
}
export interface EmbeddingRequest {
  readonly input: readonly string[];
  readonly model?: string;
}
export interface EmbeddingResponse {
  readonly dimensions: number;
  readonly embeddings: readonly (readonly number[])[];
  readonly model: string;
  readonly providerId: string;
  readonly usage: TokenUsage;
}
export interface ModelDescriptor {
  readonly capabilities: ReadonlySet<ModelCapability>;
  readonly contextWindow: number;
  readonly enabled: boolean;
  readonly id: string;
  readonly location: ModelLocation;
  readonly maxOutputTokens: number;
  readonly priority: number;
  readonly providerId: string;
}
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest, model: ModelDescriptor): Promise<ModelResponse>;
  embed(request: EmbeddingRequest, model: ModelDescriptor): Promise<EmbeddingResponse>;
  health(): Promise<boolean>;
  stream(request: ModelRequest, model: ModelDescriptor): AsyncIterable<ModelStreamChunk>;
}
export interface RouteRequest {
  readonly capabilities: ReadonlySet<ModelCapability>;
  readonly estimatedInputTokens?: number;
  readonly locationPreference?: ModelLocation | "any";
  readonly modelId?: string;
  readonly providerId?: string;
}
export class ModelProviderError extends Error {
  public constructor(
    message: string,
    public readonly providerId: string,
    public readonly retryable: boolean,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ModelProviderError";
  }
}
