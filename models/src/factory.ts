import type { ModelProvider } from "./contracts.js";
import { AnthropicProvider } from "./anthropic.js";
import { GeminiProvider } from "./gemini.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";

export interface ModelProviderConfiguration {
  readonly baseUrl: string;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly id: string;
  readonly timeoutMs: number;
  readonly type: "anthropic" | "gemini" | "openai-compatible";
}

export function createModelProvider(
  configuration: ModelProviderConfiguration,
  apiKey?: string
): ModelProvider {
  const options = {
    ...(apiKey === undefined ? {} : { apiKey }),
    baseUrl: configuration.baseUrl,
    ...(configuration.defaultHeaders === undefined
      ? {}
      : { defaultHeaders: configuration.defaultHeaders }),
    id: configuration.id,
    timeoutMs: configuration.timeoutMs
  };
  if (configuration.type === "anthropic") return new AnthropicProvider(options);
  if (configuration.type === "gemini") return new GeminiProvider(options);
  return new OpenAICompatibleProvider(options);
}
