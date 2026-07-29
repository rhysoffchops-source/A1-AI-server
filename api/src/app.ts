import { timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AgentDefinition, ComputeProvider } from "@a1/agents";
import type { A1Config } from "@a1/config";
import type {
  AnyEventHandler,
  EventBus,
  HealthRegistry,
  JsonObject,
  JsonValue,
  Logger
} from "@a1/core";
import { assertJsonValue } from "@a1/core";
import type { MemoryEngine } from "@a1/memory";
import type { ModelCatalog } from "@a1/models";
import type { GpuMonitor, MetricsRegistry } from "@a1/monitoring";
import { systemSnapshot } from "@a1/monitoring";
import type { TaskScheduler, TaskStatus } from "@a1/orchestrator";
import type { PluginManager } from "@a1/plugins";
import type { ProjectRegistry, WorkerCommand, WorkerRegistry } from "@a1/projects";
import {
  AuthorizationDeniedError,
  type Approval,
  type ApprovalGate,
  type HmacTokenService,
  type PermissionAuthorizer,
  type Principal
} from "@a1/security";
import type { BackupService, BackupSource } from "@a1/services";

declare module "fastify" {
  interface FastifyRequest {
    a1Principal: Principal | null;
  }
}

export interface ControlPlaneServices<TEventMap extends object> {
  readonly agents: readonly AgentDefinition[];
  readonly approvalGate: ApprovalGate;
  readonly authorizer: PermissionAuthorizer;
  readonly backupSources: readonly BackupSource[];
  readonly backups: BackupService;
  readonly compute: ReadonlyMap<string, ComputeProvider>;
  readonly events: EventBus<TEventMap>;
  readonly gpu: GpuMonitor;
  readonly memory: MemoryEngine;
  readonly metrics: MetricsRegistry;
  readonly models: ModelCatalog;
  readonly plugins: PluginManager;
  readonly projects: ProjectRegistry;
  readonly scheduler: TaskScheduler;
  readonly workers: WorkerRegistry;
}

export interface BuildAppOptions<TEventMap extends object = Record<string, JsonValue>> {
  readonly config: A1Config;
  readonly control?: ControlPlaneServices<TEventMap>;
  readonly health: HealthRegistry;
  readonly logger: Logger;
  readonly tokenService?: HmacTokenService;
  readonly workerTokens?: ReadonlyMap<string, string>;
}

export type A1FastifyInstance = FastifyInstance<
  http.Server,
  http.IncomingMessage,
  http.ServerResponse,
  Logger
>;

function objectBody(value: unknown): JsonObject {
  assertJsonValue(value, "request body");
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  return value as JsonObject;
}

function requiredString(value: JsonValue | undefined, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function taskStatus(value: string | undefined): TaskStatus | undefined {
  return value === "cancelled" ||
    value === "failed" ||
    value === "queued" ||
    value === "running" ||
    value === "succeeded"
    ? value
    : undefined;
}

function approvalBody(value: JsonValue | undefined): Approval {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("approval must be an object.");
  }
  const approval = value as JsonObject;
  return {
    action: requiredString(approval.action, "approval.action"),
    approvedBy: requiredString(approval.approvedBy, "approval.approvedBy"),
    id: requiredString(approval.id, "approval.id"),
    target: requiredString(approval.target, "approval.target"),
    token: requiredString(approval.token, "approval.token")
  };
}

function workerCommandKind(
  value: JsonValue | undefined
): "project.verify" | "shell" | "system.inspect" {
  if (value === "project.verify" || value === "shell" || value === "system.inspect") return value;
  throw new TypeError("kind must be project.verify, shell, or system.inspect.");
}

function workerTokenMatches(
  authorization: string | undefined,
  workerId: string,
  workerTokens: ReadonlyMap<string, string> | undefined
): boolean {
  if (!authorization?.startsWith("Worker ")) return false;
  const expected = workerTokens?.get(workerId);
  if (expected === undefined) return false;
  const supplied = authorization.slice("Worker ".length);
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function workerProjectObservation(value: JsonObject): {
  readonly branch: string;
  readonly changedFiles: number;
  readonly fingerprint: string;
  readonly path: string;
} {
  const changedFiles = value.changedFiles;
  if (typeof changedFiles !== "number" || !Number.isSafeInteger(changedFiles) || changedFiles < 0) {
    throw new TypeError("Worker project changedFiles must be a non-negative integer.");
  }
  return {
    branch: requiredString(value.branch, "worker project branch"),
    changedFiles,
    fingerprint: requiredString(value.fingerprint, "worker project fingerprint"),
    path: requiredString(value.path, "worker project path")
  };
}

function workerProjectObservations(
  value: JsonObject
): readonly ReturnType<typeof workerProjectObservation>[] {
  const projects = value.projects;
  if (projects === undefined) return [];
  if (!Array.isArray(projects)) throw new TypeError("metadata.projects must be an array.");
  return projects.map((project) => workerProjectObservation(objectBody(project)));
}

function watchdogInput(command: WorkerCommand): string | undefined {
  if (command.kind !== "project.verify" || command.result === undefined) return undefined;
  const fingerprint = command.payload.fingerprint;
  const path = command.payload.path;
  if (typeof fingerprint !== "string" || typeof path !== "string") return undefined;
  const result = JSON.stringify(command.result);
  const boundedResult =
    result.length <= 700_000 ? result : `${result.slice(0, 700_000)}\n… truncated`;
  return [
    "Review the exact code snapshot below as A1's dedicated Code Watchdog.",
    "You must evaluate intent, correctness, syntax, structure, tests, and security.",
    "The deterministic verifier may pass while the code is still wrong; do not treat it as approval.",
    "You must make exactly one code_watchdog_decision tool call for this exact workerId, path, and fingerprint.",
    "Use approved only when the code is safe to write/deploy. Use fix_required for a non-destructive correction gate. Use blocked for serious or unsafe issues; this queues a physical source-tree lock.",
    "Do not claim a decision without that tool call. Explain findings concisely after it.",
    `workerId: ${command.workerId}`,
    `path: ${path}`,
    `fingerprint: ${fingerprint}`,
    "Verifier result and bounded source review context:",
    boundedResult
  ].join("\n\n");
}

export async function buildApp<TEventMap extends object>(
  options: BuildAppOptions<TEventMap>
): Promise<A1FastifyInstance> {
  const app = Fastify({
    bodyLimit: options.config.server.bodyLimitBytes,
    loggerInstance: options.logger,
    requestTimeout: options.config.server.requestTimeoutMs,
    trustProxy: options.config.server.trustProxy
  });
  app.decorateRequest("a1Principal", null);
  const localPrincipal: Principal = {
    id: "a1-local-operator",
    permissions: new Set(["*"]),
    roles: new Set(["administrator"])
  };

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        connectSrc: ["'self'"],
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"]
      }
    },
    global: true
  });

  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    // The dashboard shell must remain readable so an operator can enter a
    // short-lived bearer token in the browser. Its data and all control-plane
    // actions remain under /api/ and continue to require authentication.
    const requestPath = request.url.split("?", 1)[0];
    const isDashboardAsset =
      request.method === "GET" &&
      (requestPath === "/" ||
        requestPath === "/index.html" ||
        requestPath === "/app.js" ||
        requestPath === "/styles.css");
    const isWorkerRequest =
      request.url.startsWith("/api/v1/workers/") && authorization?.startsWith("Worker ");
    if (
      options.tokenService === undefined ||
      isDashboardAsset ||
      request.url.startsWith("/health/") ||
      request.url === "/metrics" ||
      isWorkerRequest
    ) {
      return;
    }
    if (!authorization?.startsWith("Bearer ")) {
      await reply.status(401).send({ error: "Unauthorized", message: "Bearer token required." });
      return;
    }
    try {
      request.a1Principal = options.tokenService.verify(authorization.slice(7));
    } catch {
      await reply.status(401).send({ error: "Unauthorized", message: "Bearer token invalid." });
    }
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error }, "Request failed");
    const statusCode =
      error instanceof AuthorizationDeniedError
        ? 403
        : error instanceof TypeError || error instanceof RangeError
          ? 400
          : typeof error.statusCode === "number" &&
              error.statusCode >= 400 &&
              error.statusCode < 500
            ? error.statusCode
            : 500;
    return reply.status(statusCode).send({
      error:
        statusCode === 500
          ? "Internal Server Error"
          : statusCode === 403
            ? "Forbidden"
            : error.name,
      message: statusCode === 500 ? "The request could not be completed." : error.message,
      requestId: request.id,
      statusCode
    });
  });

  app.get("/health/live", () => ({
    status: "healthy",
    timestamp: new Date().toISOString()
  }));

  app.get("/health/ready", async (_request, reply) => {
    const snapshot = await options.health.inspect();
    return reply.status(snapshot.status === "unhealthy" ? 503 : 200).send(snapshot);
  });

  const control = options.control;
  if (control !== undefined) {
    const requestCounter = control.metrics.counter(
      "a1_http_requests_total",
      "Total HTTP requests received by the A1 control plane."
    );
    const readinessGauge = control.metrics.gauge(
      "a1_readiness",
      "Whether all required A1 dependencies are ready."
    );
    app.addHook("onRequest", () => {
      requestCounter.increment();
      return Promise.resolve();
    });

    const principal = (request: FastifyRequest): Principal => {
      if (options.tokenService === undefined) return localPrincipal;
      if (request.a1Principal === null) throw new AuthorizationDeniedError("anonymous", "session");
      return request.a1Principal;
    };
    const requirePermission = (request: FastifyRequest, permission: string): Principal => {
      const identity = principal(request);
      control.authorizer.require(identity, permission);
      return identity;
    };

    app.get("/metrics", async (_request, reply) => {
      const health = await options.health.inspect();
      readinessGauge.set(health.status === "unhealthy" ? 0 : 1);
      return reply.type("text/plain; version=0.0.4; charset=utf-8").send(control.metrics.render());
    });

    app.get("/api/v1/dashboard", async (request) => {
      requirePermission(request, "dashboard:read");
      const [health, gpu, tasks, projects, memory, workers, codeVerification] = await Promise.all([
        options.health.inspect(),
        options.config.monitoring.gpu.enabled ? control.gpu.inspect() : Promise.resolve([]),
        control.scheduler.list(50),
        control.projects.list(),
        control.memory.search({ limit: options.config.memory.defaultSearchLimit }),
        control.workers.list(),
        control.workers.listProjects()
      ]);
      return {
        agents: control.agents.map((agent) => ({
          id: agent.id,
          locationPreference: agent.locationPreference,
          maxSteps: agent.maxSteps,
          name: agent.name
        })),
        gpu,
        health: {
          checks: Object.fromEntries(
            health.checks.map((check) => [
              check.name,
              { durationMs: check.durationMs, message: check.message, status: check.status }
            ])
          ),
          status: health.status
        },
        memory,
        models: control.models.list().map((model) => ({
          ...model,
          capabilities: [...model.capabilities]
        })),
        plugins: control.plugins.list(),
        codeVerification,
        projects,
        system: systemSnapshot(),
        tasks,
        workers
      };
    });

    app.get("/api/v1/workers", async (request) => {
      requirePermission(request, "worker:read");
      return { workers: await control.workers.list() };
    });
    app.get("/api/v1/code-verification", async (request) => {
      requirePermission(request, "worker:read");
      return { projects: await control.workers.listProjects() };
    });
    app.get<{ Params: { workerId: string }; Querystring: { limit?: string } }>(
      "/api/v1/workers/:workerId/commands",
      async (request) => {
        requirePermission(request, "worker:read");
        const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
        return { commands: await control.workers.listCommands(request.params.workerId, limit) };
      }
    );
    app.post<{ Params: { workerId: string } }>(
      "/api/v1/workers/:workerId/commands",
      async (request, reply) => {
        requirePermission(request, "worker:execute");
        const body = objectBody(request.body);
        const payload = body.payload;
        if (payload === undefined) throw new TypeError("payload is required.");
        return reply.status(201).send(
          await control.workers.queue({
            kind: workerCommandKind(body.kind),
            payload: objectBody(payload),
            workerId: request.params.workerId
          })
        );
      }
    );
    app.post<{ Params: { workerId: string } }>(
      "/api/v1/workers/:workerId/heartbeat",
      async (request, reply) => {
        if (
          !workerTokenMatches(
            request.headers.authorization,
            request.params.workerId,
            options.workerTokens
          )
        ) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Valid worker token required." });
        }
        const body = objectBody(request.body);
        const metadata = body.metadata;
        if (metadata === undefined) throw new TypeError("metadata is required.");
        const metadataObject = objectBody(metadata);
        const worker = await control.workers.heartbeat(request.params.workerId, metadataObject);
        const projects = await control.workers.observeProjects(
          request.params.workerId,
          workerProjectObservations(metadataObject)
        );
        return reply.send({ projects, worker });
      }
    );
    app.post<{ Params: { workerId: string } }>(
      "/api/v1/workers/:workerId/poll",
      async (request, reply) => {
        if (
          !workerTokenMatches(
            request.headers.authorization,
            request.params.workerId,
            options.workerTokens
          )
        ) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Valid worker token required." });
        }
        const command = await control.workers.claim(request.params.workerId);
        return command === undefined ? reply.status(204).send() : reply.send({ command });
      }
    );
    app.post<{ Params: { commandId: string; workerId: string } }>(
      "/api/v1/workers/:workerId/commands/:commandId/result",
      async (request, reply) => {
        if (
          !workerTokenMatches(
            request.headers.authorization,
            request.params.workerId,
            options.workerTokens
          )
        ) {
          return reply
            .status(401)
            .send({ error: "Unauthorized", message: "Valid worker token required." });
        }
        const body = objectBody(request.body);
        const result = body.result;
        if (result === undefined) throw new TypeError("result is required.");
        const resultObject = objectBody(result);
        const status = body.status;
        if (status !== "failed" && status !== "succeeded") {
          throw new TypeError("status must be failed or succeeded.");
        }
        const observation = resultObject.projectObservation;
        if (observation !== undefined) {
          await control.workers.observeProjects(request.params.workerId, [
            workerProjectObservation(objectBody(observation))
          ]);
        }
        const command = await control.workers.complete({
          commandId: request.params.commandId,
          result: resultObject,
          status,
          workerId: request.params.workerId
        });
        const input = watchdogInput(command);
        const verification =
          command.kind === "project.verify" &&
          typeof command.payload.path === "string" &&
          typeof command.payload.fingerprint === "string"
            ? await control.workers.getProject(request.params.workerId, command.payload.path)
            : undefined;
        let watchdogTask: unknown;
        if (
          input !== undefined &&
          verification !== undefined &&
          verification.fingerprint === command.payload.fingerprint &&
          verification.lastVerifiedFingerprint === verification.fingerprint &&
          (verification.verificationStatus === "passed" ||
            verification.verificationStatus === "failed") &&
          control.agents.some((agent) => agent.id === "code-watchdog")
        ) {
          try {
            watchdogTask = await control.scheduler.schedule({
              kind: "agent.run",
              payload: { agentId: "code-watchdog", input }
            });
          } catch (error: unknown) {
            request.log.error(
              { err: error, workerId: request.params.workerId },
              "Failed to queue Code Watchdog review"
            );
          }
        }
        return reply.send({
          command,
          ...(watchdogTask === undefined ? {} : { watchdogTask })
        });
      }
    );

    app.post<{ Params: { workerId: string } }>(
      "/api/v1/code-verification/:workerId/unlock",
      async (request, reply) => {
        requirePermission(request, "code:unlock");
        const body = objectBody(request.body);
        const projectPath = requiredString(body.path, "path");
        const approval = approvalBody(body.approval);
        control.approvalGate.consume(
          approval,
          "code.unlock",
          `${request.params.workerId}:${projectPath}`
        );
        return reply.status(202).send({
          command: await control.workers.requestProjectUnlock(request.params.workerId, projectPath)
        });
      }
    );

    app.get<{ Querystring: { limit?: string; status?: string } }>(
      "/api/v1/tasks",
      async (request) => {
        requirePermission(request, "task:read");
        const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
        return {
          tasks: await control.scheduler.list(limit, taskStatus(request.query.status))
        };
      }
    );

    app.get<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
      requirePermission(request, "task:read");
      const task = await control.scheduler.get(request.params.id);
      return task ?? reply.status(404).send({ error: "Not Found", message: "Task not found." });
    });

    app.post("/api/v1/agents/runs", async (request, reply) => {
      requirePermission(request, "agent:run");
      const body = objectBody(request.body);
      const agentId = requiredString(body.agentId, "agentId");
      if (!control.agents.some((agent) => agent.id === agentId)) {
        return reply.status(404).send({ error: "Not Found", message: "Agent not found." });
      }
      const task = await control.scheduler.schedule({
        kind: "agent.run",
        payload: {
          agentId,
          input: requiredString(body.input, "input")
        }
      });
      return reply.status(202).send(task);
    });

    app.get("/api/v1/projects", async (request) => {
      requirePermission(request, "project:read");
      return { projects: await control.projects.list() };
    });

    app.get("/api/v1/backups", async (request) => {
      requirePermission(request, "backup:read");
      return { backups: await control.backups.list() };
    });
    app.post("/api/v1/backups", async (request, reply) => {
      requirePermission(request, "backup:create");
      return reply.status(201).send(await control.backups.create(control.backupSources));
    });

    app.get<{ Params: { instanceId: string; providerId: string } }>(
      "/api/v1/compute/:providerId/instances/:instanceId",
      async (request, reply) => {
        requirePermission(request, "compute:read");
        const provider = control.compute.get(request.params.providerId);
        return provider === undefined
          ? reply.status(404).send({ error: "Not Found", message: "Compute provider not found." })
          : provider.get(request.params.instanceId);
      }
    );
    app.post<{ Params: { providerId: string } }>(
      "/api/v1/compute/:providerId/instances",
      async (request, reply) => {
        requirePermission(request, "compute:provision");
        const provider = control.compute.get(request.params.providerId);
        if (provider === undefined) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Compute provider not found." });
        }
        const body = objectBody(request.body);
        const offerId = requiredString(body.offerId, "offerId");
        control.approvalGate.consume(
          approvalBody(body.approval),
          "compute.provision",
          `${request.params.providerId}:${offerId}`
        );
        const diskGb = Number(body.diskGb);
        if (!Number.isSafeInteger(diskGb) || diskGb <= 0) {
          throw new TypeError("diskGb must be a positive integer.");
        }
        const environmentValue = body.environment;
        let environment: Record<string, string> | undefined;
        if (environmentValue !== undefined) {
          if (
            environmentValue === null ||
            typeof environmentValue !== "object" ||
            Array.isArray(environmentValue) ||
            !Object.values(environmentValue).every((value) => typeof value === "string")
          ) {
            throw new TypeError("environment must contain only string values.");
          }
          environment = environmentValue as Record<string, string>;
        }
        return reply.status(201).send(
          await provider.provision({
            diskGb,
            ...(environment === undefined ? {} : { environment }),
            image: requiredString(body.image, "image"),
            offerId,
            ...(typeof body.onStart === "string" ? { onStart: body.onStart } : {})
          })
        );
      }
    );
    app.delete<{ Params: { instanceId: string; providerId: string } }>(
      "/api/v1/compute/:providerId/instances/:instanceId",
      async (request, reply) => {
        requirePermission(request, "compute:release");
        const provider = control.compute.get(request.params.providerId);
        if (provider === undefined) {
          return reply
            .status(404)
            .send({ error: "Not Found", message: "Compute provider not found." });
        }
        const body = objectBody(request.body);
        const target = `${request.params.providerId}:${request.params.instanceId}`;
        control.approvalGate.consume(approvalBody(body.approval), "compute.release", target);
        await provider.release(request.params.instanceId);
        return reply.status(204).send();
      }
    );
    app.post("/api/v1/projects", async (request, reply) => {
      requirePermission(request, "project:create");
      const body = objectBody(request.body);
      const project = await control.projects.create({
        name: requiredString(body.name, "name"),
        path: requiredString(body.path, "path")
      });
      return reply.status(201).send(project);
    });

    app.get<{ Querystring: { q?: string } }>("/api/v1/memory/search", async (request) => {
      requirePermission(request, "memory:read");
      return {
        results: await control.memory.search({
          limit: options.config.memory.defaultSearchLimit,
          ...(request.query.q === undefined ? {} : { query: request.query.q })
        })
      };
    });

    app.post("/api/v1/approvals", (request, reply) => {
      const identity = requirePermission(request, "approval:issue");
      const body = objectBody(request.body);
      const approval = control.approvalGate.issue(
        identity,
        requiredString(body.action, "action"),
        requiredString(body.target, "target")
      );
      return reply.status(201).send(approval);
    });

    app.delete<{ Params: { id: string } }>("/api/v1/tasks/:id", async (request, reply) => {
      requirePermission(request, "task:cancel");
      const body = objectBody(request.body);
      const approval = approvalBody(body.approval);
      control.approvalGate.consume(approval, "task.cancel", request.params.id);
      const task = await control.scheduler.cancel(request.params.id);
      return (
        task ?? reply.status(409).send({ error: "Conflict", message: "Task cannot be cancelled." })
      );
    });

    app.get("/api/v1/events", (request, reply) => {
      requirePermission(request, "events:read");
      reply.hijack();
      reply.raw.writeHead(200, {
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no"
      });
      reply.raw.write(": connected\n\n");
      const handler: AnyEventHandler<TEventMap> = (event) => {
        reply.raw.write(`id: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
      };
      const unsubscribe = control.events.subscribeAll(handler);
      const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 15_000);
      heartbeat.unref();
      request.raw.once("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });
  }

  const staticRoot = resolve(fileURLToPath(new URL("../../ui/dist", import.meta.url)));
  try {
    await access(resolve(staticRoot, "index.html"));
    await app.register(fastifyStatic, {
      index: "index.html",
      root: staticRoot,
      wildcard: false
    });
  } catch {
    app.get("/", (_request, reply) =>
      reply.status(503).send({ error: "Unavailable", message: "Dashboard assets are not built." })
    );
  }

  return app;
}
