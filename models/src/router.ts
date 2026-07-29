import type {
  EmbeddingRequest,
  EmbeddingResponse,
  ModelDescriptor,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  RouteRequest
} from "./contracts.js";

export class ModelCatalog {
  readonly #models = new Map<string, ModelDescriptor>();

  public register(model: ModelDescriptor): void {
    if (this.#models.has(model.id)) throw new Error(`Model "${model.id}" is already registered.`);
    if (model.contextWindow <= 0 || model.maxOutputTokens <= 0) {
      throw new RangeError("Model token limits must be positive.");
    }
    this.#models.set(model.id, { ...model, capabilities: new Set(model.capabilities) });
  }

  public list(): readonly ModelDescriptor[] {
    return [...this.#models.values()].sort(
      (a, b) => b.priority - a.priority || a.id.localeCompare(b.id)
    );
  }

  public route(request: RouteRequest): readonly ModelDescriptor[] {
    return this.list()
      .filter((model) => model.enabled)
      .filter((model) => request.modelId === undefined || model.id === request.modelId)
      .filter(
        (model) => request.providerId === undefined || model.providerId === request.providerId
      )
      .filter((model) =>
        [...request.capabilities].every((capability) => model.capabilities.has(capability))
      )
      .filter((model) => (request.estimatedInputTokens ?? 0) <= model.contextWindow)
      .sort((left, right) => {
        const preferred = request.locationPreference;
        if (preferred !== undefined && preferred !== "any" && left.location !== right.location) {
          return left.location === preferred ? -1 : 1;
        }
        return right.priority - left.priority || left.id.localeCompare(right.id);
      });
  }
}

export class ModelManager {
  readonly #providers = new Map<string, ModelProvider>();
  public constructor(public readonly catalog: ModelCatalog) {}

  public registerProvider(provider: ModelProvider): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider "${provider.id}" is already registered.`);
    }
    this.#providers.set(provider.id, provider);
  }

  public complete(route: RouteRequest, request: ModelRequest): Promise<ModelResponse> {
    return this.#withFallback(route, (provider, model) => provider.complete(request, model));
  }

  public embed(route: RouteRequest, request: EmbeddingRequest): Promise<EmbeddingResponse> {
    return this.#withFallback(route, (provider, model) => provider.embed(request, model));
  }

  async #withFallback<T>(
    route: RouteRequest,
    execute: (provider: ModelProvider, model: ModelDescriptor) => Promise<T>
  ): Promise<T> {
    const candidates = this.catalog.route(route);
    if (candidates.length === 0) throw new Error("No model satisfies the requested route.");
    const failures: unknown[] = [];
    for (const model of candidates) {
      const provider = this.#providers.get(model.providerId);
      if (provider === undefined) {
        failures.push(new Error(`Provider "${model.providerId}" is not registered.`));
        continue;
      }
      try {
        return await execute(provider, model);
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    throw new AggregateError(failures, "Every routed model failed.");
  }
}
