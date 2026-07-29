import { describe, expect, it } from "vitest";

import type { ModelDescriptor, ModelProvider } from "./contracts.js";
import { ModelCatalog, ModelManager } from "./router.js";

function descriptor(
  id: string,
  providerId: string,
  priority: number,
  location: "cloud" | "local"
): ModelDescriptor {
  return {
    capabilities: new Set(["coding", "reasoning"]),
    contextWindow: 128_000,
    enabled: true,
    id,
    location,
    maxOutputTokens: 8_192,
    priority,
    providerId
  };
}

function provider(id: string, result: string): ModelProvider {
  return {
    id,
    complete: (_request, model) =>
      result === "fail"
        ? Promise.reject(new Error("unavailable"))
        : Promise.resolve({
            finishReason: "stop",
            id: "response",
            model: model.id,
            providerId: id,
            text: result,
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
          }),
    embed: () => Promise.reject(new Error("not used")),
    health: () => Promise.resolve(true),
    stream: async function* () {
      await Promise.resolve();
      yield* [];
    }
  };
}

describe("ModelManager", () => {
  it("routes by capability, location, and priority", () => {
    const catalog = new ModelCatalog();
    catalog.register(descriptor("cloud-fast", "cloud", 100, "cloud"));
    catalog.register(descriptor("local-safe", "local", 10, "local"));
    expect(
      catalog.route({ capabilities: new Set(["coding"]), locationPreference: "local" })[0]?.id
    ).toBe("local-safe");
  });

  it("falls back to the next compatible provider", async () => {
    const catalog = new ModelCatalog();
    catalog.register(descriptor("primary", "primary", 100, "cloud"));
    catalog.register(descriptor("fallback", "fallback", 50, "local"));
    const manager = new ModelManager(catalog);
    manager.registerProvider(provider("primary", "fail"));
    manager.registerProvider(provider("fallback", "ok"));
    const response = await manager.complete(
      { capabilities: new Set(["reasoning"]), locationPreference: "any" },
      { messages: [{ content: "hello", role: "user" }] }
    );
    expect(response.model).toBe("fallback");
    expect(response.text).toBe("ok");
  });
});
