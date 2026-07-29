import { randomUUID } from "node:crypto";

import { assertJsonValue, cloneJsonValue, freezeJsonValue, type JsonValue } from "./json.js";

type EventKey<TEventMap extends object> = Extract<keyof TEventMap, string>;
type EventPayload<
  TEventMap extends object,
  TType extends EventKey<TEventMap>
> = TEventMap[TType] extends JsonValue ? TEventMap[TType] : never;

export interface EventInput<
  TEventMap extends object,
  TType extends EventKey<TEventMap> = EventKey<TEventMap>
> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly payload: EventPayload<TEventMap, TType>;
  readonly source: string;
  readonly type: TType;
}

export interface DomainEvent<
  TType extends string = string,
  TPayload extends JsonValue = JsonValue
> {
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly occurredAt: string;
  readonly payload: TPayload;
  readonly source: string;
  readonly type: TType;
}

export type AnyDomainEvent<TEventMap extends object> = {
  [TType in EventKey<TEventMap>]: DomainEvent<TType, EventPayload<TEventMap, TType>>;
}[EventKey<TEventMap>];

export type EventHandler<TEventMap extends object, TType extends EventKey<TEventMap>> = (
  event: DomainEvent<TType, EventPayload<TEventMap, TType>>
) => Promise<void> | void;

export type AnyEventHandler<TEventMap extends object> = (
  event: AnyDomainEvent<TEventMap>
) => Promise<void> | void;

export interface EventPublisher<TEventMap extends object> {
  publish<TType extends EventKey<TEventMap>>(
    input: EventInput<TEventMap, TType>
  ): Promise<DomainEvent<TType, EventPayload<TEventMap, TType>>>;
}

export interface EventBus<TEventMap extends object> extends EventPublisher<TEventMap> {
  subscribe<TType extends EventKey<TEventMap>>(
    type: TType,
    handler: EventHandler<TEventMap, TType>
  ): () => void;
  subscribeAll(handler: AnyEventHandler<TEventMap>): () => void;
}

export interface EventHandlerFailure {
  readonly error: unknown;
  readonly subscriberId: string;
}

export class EventDispatchError extends Error {
  public constructor(
    public readonly eventId: string,
    public readonly failures: readonly EventHandlerFailure[]
  ) {
    super(
      `Event "${eventId}" failed in ${String(failures.length)} subscriber${
        failures.length === 1 ? "" : "s"
      }.`
    );
    this.name = "EventDispatchError";
  }
}

interface StoredHandler {
  readonly handle: (event: DomainEvent) => Promise<void> | void;
  readonly id: string;
}

export class InMemoryEventBus<TEventMap extends object> implements EventBus<TEventMap> {
  readonly #allHandlers = new Map<symbol, StoredHandler>();
  readonly #handlers = new Map<string, Map<symbol, StoredHandler>>();
  #dispatchTail: Promise<void> = Promise.resolve();

  public subscribe<TType extends EventKey<TEventMap>>(
    type: TType,
    handler: EventHandler<TEventMap, TType>
  ): () => void {
    const key = Symbol(type);
    const handlersForType = this.#handlers.get(type) ?? new Map<symbol, StoredHandler>();
    handlersForType.set(key, {
      handle: handler as (event: DomainEvent) => Promise<void> | void,
      id: randomUUID()
    });
    this.#handlers.set(type, handlersForType);

    return (): void => {
      const currentHandlers = this.#handlers.get(type);
      currentHandlers?.delete(key);
      if (currentHandlers?.size === 0) {
        this.#handlers.delete(type);
      }
    };
  }

  public subscribeAll(handler: AnyEventHandler<TEventMap>): () => void {
    const key = Symbol("all-events");
    this.#allHandlers.set(key, {
      handle: handler as (event: DomainEvent) => Promise<void> | void,
      id: randomUUID()
    });

    return (): void => {
      this.#allHandlers.delete(key);
    };
  }

  public async publish<TType extends EventKey<TEventMap>>(
    input: EventInput<TEventMap, TType>
  ): Promise<DomainEvent<TType, EventPayload<TEventMap, TType>>> {
    assertJsonValue(input.payload, "event payload");

    const event: DomainEvent<TType, EventPayload<TEventMap, TType>> = {
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      payload: freezeJsonValue(cloneJsonValue(input.payload)),
      source: input.source,
      type: input.type
    };

    const dispatch = this.#dispatchTail.then(async () => {
      await this.#dispatch(event);
    });
    this.#dispatchTail = dispatch.catch(() => undefined);
    await dispatch;

    return event;
  }

  async #dispatch(event: AnyDomainEvent<TEventMap>): Promise<void> {
    const handlers = [
      ...(this.#handlers.get(event.type)?.values() ?? []),
      ...this.#allHandlers.values()
    ];
    const failures: EventHandlerFailure[] = [];

    for (const handler of handlers) {
      try {
        await handler.handle(event);
      } catch (error: unknown) {
        failures.push({
          error,
          subscriberId: handler.id
        });
      }
    }

    if (failures.length > 0) {
      throw new EventDispatchError(event.id, failures);
    }
  }
}
