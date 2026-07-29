import { randomUUID } from "node:crypto";

import {
  assertJsonValue,
  cloneJsonValue,
  type HealthCheckResult,
  type JsonObject,
  type LifecycleComponent
} from "@a1/core";

export type AuditActorKind = "agent" | "plugin" | "service" | "system" | "user";
export type AuditOutcome = "denied" | "failure" | "success";
export type AuditSeverity = "critical" | "info" | "warning";

export interface AuditActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

export interface AuditTarget {
  readonly id: string;
  readonly type: string;
}

export interface AuditInput {
  readonly action: string;
  readonly actor: AuditActor;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly metadata?: JsonObject;
  readonly outcome: AuditOutcome;
  readonly reason?: string;
  readonly severity: AuditSeverity;
  readonly target?: AuditTarget;
}

export interface AuditEnvelope {
  readonly action: string;
  readonly actor: AuditActor;
  readonly causationId?: string;
  readonly correlationId?: string;
  readonly id: string;
  readonly metadata: JsonObject;
  readonly occurredAt: string;
  readonly outcome: AuditOutcome;
  readonly reason?: string;
  readonly severity: AuditSeverity;
  readonly target?: AuditTarget;
}

export interface AuditSink {
  close(): Promise<void>;
  open(): Promise<void>;
  append(envelope: AuditEnvelope): Promise<void>;
}

export interface AuditRecorder {
  record(input: AuditInput): Promise<AuditEnvelope>;
}

export class AuditService implements AuditRecorder, LifecycleComponent {
  public readonly name = "audit-service";
  #lastError: string | undefined;
  #state: "idle" | "running" | "stopped" | "failed" = "idle";

  public constructor(private readonly sink: AuditSink) {}

  public async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new Error(`Audit service cannot start from state "${this.#state}".`);
    }

    try {
      await this.sink.open();
      this.#state = "running";
    } catch (error: unknown) {
      this.#lastError = error instanceof Error ? error.message : "Audit sink failed to open.";
      this.#state = "failed";
      throw error;
    }
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "idle") {
      this.#state = "stopped";
      return;
    }

    try {
      await this.sink.close();
      this.#state = "stopped";
    } catch (error: unknown) {
      this.#lastError = error instanceof Error ? error.message : "Audit sink failed to close.";
      this.#state = "failed";
      throw error;
    }
  }

  public async record(input: AuditInput): Promise<AuditEnvelope> {
    if (this.#state !== "running") {
      throw new Error("Audit service is not running.");
    }

    if (input.action.trim().length === 0 || input.actor.id.trim().length === 0) {
      throw new TypeError("Audit action and actor ID cannot be empty.");
    }
    if (!["agent", "plugin", "service", "system", "user"].includes(input.actor.kind)) {
      throw new TypeError(`Unsupported audit actor kind "${input.actor.kind}".`);
    }
    if (!["denied", "failure", "success"].includes(input.outcome)) {
      throw new TypeError(`Unsupported audit outcome "${input.outcome}".`);
    }
    if (!["critical", "info", "warning"].includes(input.severity)) {
      throw new TypeError(`Unsupported audit severity "${input.severity}".`);
    }
    if (
      input.target !== undefined &&
      (input.target.id.trim().length === 0 || input.target.type.trim().length === 0)
    ) {
      throw new TypeError("Audit target ID and type cannot be empty.");
    }

    const metadata = input.metadata ?? {};
    assertJsonValue(metadata, "audit metadata");
    const envelope: AuditEnvelope = {
      action: input.action,
      actor: { ...input.actor },
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      id: randomUUID(),
      metadata: cloneJsonValue(metadata),
      occurredAt: new Date().toISOString(),
      outcome: input.outcome,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      severity: input.severity,
      ...(input.target === undefined ? {} : { target: { ...input.target } })
    };

    try {
      await this.sink.append(envelope);
      this.#lastError = undefined;
      return envelope;
    } catch (error: unknown) {
      this.#lastError = error instanceof Error ? error.message : "Audit append failed.";
      throw error;
    }
  }

  public health(): HealthCheckResult {
    if (this.#state !== "running") {
      return {
        message: this.#lastError ?? `Audit service is ${this.#state}.`,
        status: "unhealthy"
      };
    }

    if (this.#lastError !== undefined) {
      return {
        message: this.#lastError,
        status: "degraded"
      };
    }

    return { status: "healthy" };
  }
}
