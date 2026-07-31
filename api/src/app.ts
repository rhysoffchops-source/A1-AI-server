import { randomUUID, timingSafeEqual } from "node:crypto";
import type * as http from "node:http";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

import { optimisePromptWithTransform, supportedPlatforms, readJsonFile, writeJsonFile, validateLibraryEntry, validateThread, type PromptLibraryEntry, type PromptPlatform, type PromptThread, type PromptThreadMessage } from "./prompt-engine.js";
import { getTools, getNodes, getLogs, getPendingApprovals, executeTool, approveExecution, denyExecution, refreshNodeStatus, type McpToolDef, type McpNodeDef, type McpExecutionLog, type McpApprovalRequest } from "./mcp-bridge.js";

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
  /** A human-entered phrase used only to mint a short-lived browser session. */
  readonly dashboardPassphrase?: string;
  readonly health: HealthRegistry;
  readonly logger: Logger;
  /** Kept on the VPS volume, never in the browser. */
  readonly studioHistoryPath?: string;
  /** Kept on the VPS volume for prompt library persistence. */
  readonly promptLibraryPath?: string;
  /** Kept on the VPS volume for prompt thread persistence. */
  readonly promptThreadsPath?: string;
  /** Custom system prompt for the Concierge agent, persisted on VPS volume. */
  readonly conciergePromptPath?: string;
  readonly replicateApiToken?: string;
  readonly tokenService?: HmacTokenService;
  readonly workerTokens?: ReadonlyMap<string, string>;
}

type StudioKind = "image" | "image_edit" | "video" | "audio" | "audio_extract";
type StudioStatus = "draft" | "ready" | "needs_setup" | "completed" | "failed";
interface StudioHistoryEntry {
  readonly createdAt: string;
  readonly elapsed?: string;
  readonly id: string;
  readonly kind: StudioKind;
  readonly model?: string;
  readonly prompt: string;
  readonly referenceName?: string;
  readonly resultUrl?: string;
  readonly status: StudioStatus;
  readonly title: string;
  readonly updatedAt: string;
}

const studioKinds = new Set<StudioKind>(["image", "image_edit", "video", "audio", "audio_extract"]);
const studioStatuses = new Set<StudioStatus>([
  "draft",
  "ready",
  "needs_setup",
  "completed",
  "failed"
]);

function boundedString(value: JsonValue | undefined, name: string, maximum: number): string {
  const result = requiredString(value, name);
  if (result.length > maximum) throw new RangeError(`${name} must be ${String(maximum)} characters or fewer.`);
  return result;
}

function optionalBoundedString(
  value: JsonValue | undefined,
  name: string,
  maximum: number
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, name, maximum);
}

function studioHistoryEntry(value: unknown): StudioHistoryEntry | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.prompt !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string" ||
    !studioKinds.has(candidate.kind as StudioKind) ||
    !studioStatuses.has(candidate.status as StudioStatus) ||
    (candidate.referenceName !== undefined && typeof candidate.referenceName !== "string")
  ) {
    return undefined;
  }
  return {
    createdAt: candidate.createdAt,
    id: candidate.id,
    kind: candidate.kind as StudioKind,
    prompt: candidate.prompt,
    ...(typeof candidate.referenceName === "string" ? { referenceName: candidate.referenceName } : {}),
    status: candidate.status as StudioStatus,
    title: candidate.title,
    updatedAt: candidate.updatedAt
  };
}

async function readStudioHistory(filePath: string): Promise<readonly StudioHistoryEntry[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      const history = studioHistoryEntry(entry);
      return history === undefined ? [] : [history];
    });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function writeStudioHistory(
  filePath: string,
  entries: readonly StudioHistoryEntry[]
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, filePath);
}

function secretsMatch(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.byteLength === suppliedBytes.byteLength &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
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
  const dashboardPassphrase = options.dashboardPassphrase?.trim();
  const studioHistoryPath =
    options.studioHistoryPath ?? "/opt/a1/data/runtime/studios-history.json";
  const promptLibraryPath =
    options.promptLibraryPath ?? "/opt/a1/data/runtime/prompt-library.json";
  const promptThreadsPath =
    options.promptThreadsPath ?? "/opt/a1/data/runtime/prompt-threads.json";
  const conciergePromptPath =
    options.conciergePromptPath ?? "/opt/a1/data/runtime/concierge-prompt.json";

  const providerHealth: Record<string, { flagged: boolean; lastScore: number; lastCheck: number; deprioritized: boolean }> = {
    openrouter: { flagged: false, lastScore: 95, lastCheck: 0, deprioritized: false },
    groq: { flagged: false, lastScore: 95, lastCheck: 0, deprioritized: false },
    gemini: { flagged: false, lastScore: 95, lastCheck: 0, deprioritized: false },
    huggingface: { flagged: false, lastScore: 95, lastCheck: 0, deprioritized: false },
  };
  const replicateApiToken = options.replicateApiToken ?? undefined;
  const unlockAttempts = new Map<string, { count: number; firstFailureAt: number }>();
  const localPrincipal: Principal = {
    id: "a1-local-operator",
    permissions: new Set(["*"]),
    roles: new Set(["administrator"])
  };

  await app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          connectSrc: ["'self'", "https://a1-vps.tailffab8e.ts.net"],
          defaultSrc: ["'none'"],
          fontSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
          frameAncestors: ["'none'"],
          imgSrc: ["'self'", "https://replicate.delivery", "data:"],
          scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.tailwindcss.com"],
          scriptSrcAttr: ["'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"]
        }
      },
    crossOriginResourcePolicy: { policy: "same-origin" },
    global: true,
    referrerPolicy: { policy: "no-referrer" },
    xContentTypeOptions: true,
    xFrameOptions: { action: "deny" }
  });

  app.addHook("onRequest", async (request, reply) => {
    const authorization = request.headers.authorization;
    const requestPath = request.url.split("?", 1)[0];
    const isPublicAsset =
      request.method === "GET" &&
      (requestPath === "/" ||
        requestPath === "/index.html" ||
        requestPath === "/login.html" ||
        requestPath === "/login.js");
    const isAppAsset =
      request.method === "GET" &&
      (requestPath === "/app.html" ||
        requestPath === "/app.js" ||
        requestPath === "/styles.css");
    const isUnlockRequest = request.method === "POST" && requestPath === "/api/v1/access/unlock";
    const isWorkerRequest =
      request.url.startsWith("/api/v1/workers/") && authorization?.startsWith("Worker ");
    if (
      options.tokenService === undefined ||
      isPublicAsset ||
      isUnlockRequest ||
      request.url.startsWith("/health/") ||
      request.url === "/metrics" ||
      isWorkerRequest
    ) {
      return;
    }
    const cookieHeader = request.headers.cookie;
    const sessionToken = cookieHeader?.match(/(?:^|;\s*)a1_session=([^;]+)/)?.[1];
    if (sessionToken === undefined) {
      if (isAppAsset) {
        await reply.redirect("/", 302);
        return;
      }
      await reply.status(401).send({ error: "Unauthorized", message: "Session required." });
      return;
    }
    try {
      request.a1Principal = options.tokenService.verify(sessionToken);
    } catch {
      if (isAppAsset) {
        await reply.redirect("/", 302);
        return;
      }
      await reply.status(401).send({ error: "Unauthorized", message: "Session expired." });
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

  app.post("/api/v1/access/unlock", async (request, reply) => {
    if (options.tokenService === undefined) {
      return reply.send({ authenticated: true, token: "" });
    }
    if (dashboardPassphrase === undefined || dashboardPassphrase === "") {
      return reply.status(503).send({
        error: "Unavailable",
        message: "The dashboard access phrase has not been configured on the VPS."
      });
    }
    // Require JSON content type to prevent naive CSRF via form submission.
    const rawContentType = request.headers["content-type"];
    const contentType = (typeof rawContentType === "string" ? rawContentType : "").split(";")[0]?.trim() ?? "";
    if (contentType !== "application/json") {
      return reply.status(415).send({ error: "Unsupported Media Type", message: "Expected application/json." });
    }
    const now = Date.now();
    const clientIp = request.ip ?? "unknown";
    const attempt = unlockAttempts.get(clientIp);
    if (
      attempt !== undefined &&
      now - attempt.firstFailureAt < 300_000 &&
      attempt.count >= 5
    ) {
      return reply.status(429).send({
        error: "Too Many Requests",
        message: "Too many unsuccessful attempts. Try again in a few minutes."
      });
    }
    const body = objectBody(request.body);
    const passphrase = boundedString(body.passphrase, "passphrase", 512);
    if (!secretsMatch(dashboardPassphrase, passphrase)) {
      if (attempt === undefined || now - attempt.firstFailureAt >= 300_000) {
        unlockAttempts.set(clientIp, { count: 1, firstFailureAt: now });
      } else {
        unlockAttempts.set(clientIp, { ...attempt, count: attempt.count + 1 });
      }
      return reply.status(401).send({ error: "Unauthorized", message: "That access phrase is not correct." });
    }
    unlockAttempts.delete(clientIp);
    const token = options.tokenService.issue(localPrincipal);
    reply.header(
      "Set-Cookie",
      `a1_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`
    );
    return reply.send({ authenticated: true });
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

    app.get("/api/v1/studios/history", async (request) => {
      requirePermission(request, "dashboard:read");
      return { entries: await readStudioHistory(studioHistoryPath) };
    });

    // ── Playground helpers ──
    function errorMessage(error: unknown): string {
      if (error instanceof Error) return error.message;
      return String(error ?? "unknown provider error");
    }

    async function runPlayground(
      provider: string, model: string, intent: string, strategy: string,
      env: NodeJS.ProcessEnv
    ): Promise<{ provider: string; model: string; response: string; strategy: string; latencyMs: number; tokenCount: number | undefined; raw?: unknown }> {
      const start = Date.now();
      let prompt = intent;
      if (strategy) {
        const { generateArmory } = await import("./prompt-engine.js");
        const armory = generateArmory({ intent, model, platform: "openai" });
        const strat = armory.strategies.find((s) => s.id === strategy);
        if (strat) prompt = strat.prompt;
      }

      switch (provider) {
        case "venice": {
          const key = env.VENICE_API_KEY ?? "";
          if (!key) throw new Error("VENICE_API_KEY not configured");
          try {
            const resp = await fetch("https://api.venice.ai/api/v1/chat/completions", {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
              body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2048, venice_parameters: { include_venice_system_prompt: false } }),
              signal: AbortSignal.timeout(60_000)
            });
            if (!resp.ok) throw new Error(`Venice ${resp.status}: ${await resp.text()}`);
            const data = await resp.json() as Record<string, unknown>;
            const msg = ((data.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content) ?? "";
            return { provider, model, response: msg, latencyMs: Date.now() - start, tokenCount: (data.usage as { total_tokens: number })?.total_tokens, raw: data, strategy: strategy || "" };
          } catch (veniceError: unknown) {
            // Sovereign fallback to OpenRouter free models
            const key2 = env.OPENROUTER_API_KEY ?? "";
            if (key2) {
              const fallbackModel = model.includes("dolphin") ? "cognitivecomputations/dolphin-2.9-llama3-8b:free" : "meta-llama/llama-3-8b:free";
              const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key2}`, "HTTP-Referer": "https://a1.local" },
                body: JSON.stringify({ model: fallbackModel, messages: [{ role: "user", content: prompt }], max_tokens: 2048 }),
                signal: AbortSignal.timeout(60_000)
              });
              if (!resp.ok) throw new Error(`Venice unreachable, sovereign fallback failed (${resp.status})`);
              const data = await resp.json() as Record<string, unknown>;
              const msg = ((data.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content) ?? "";
              return { provider: "venice (sovereign fallback)", model: fallbackModel, response: msg, latencyMs: Date.now() - start, tokenCount: (data.usage as { total_tokens: number })?.total_tokens, raw: data, strategy: strategy || "" };
            }
            throw veniceError;
          }
        }
        case "openrouter": {
          const key = env.OPENROUTER_API_KEY ?? "";
          if (!key) throw new Error("OPENROUTER_API_KEY not configured");
          const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}`, "HTTP-Referer": "https://a1.local" },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2048 }),
            signal: AbortSignal.timeout(60_000)
          });
          if (!resp.ok) throw new Error(`OpenRouter ${resp.status}: ${await resp.text()}`);
          const data = await resp.json() as Record<string, unknown>;
          const msg = ((data.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content) ?? "";
          return { provider, model, response: msg, latencyMs: Date.now() - start, tokenCount: (data.usage as { total_tokens: number })?.total_tokens, raw: data, strategy: strategy || "" };
        }
        case "groq": {
          const key = env.GROQ_API_KEY ?? "";
          if (!key) throw new Error("GROQ_API_KEY not configured");
          const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_tokens: 2048 }),
            signal: AbortSignal.timeout(60_000)
          });
          if (!resp.ok) throw new Error(`Groq ${resp.status}: ${await resp.text()}`);
          const data = await resp.json() as Record<string, unknown>;
          const msg = ((data.choices as Array<{ message: { content: string } }>)?.[0]?.message?.content) ?? "";
          return { provider, model, response: msg, latencyMs: Date.now() - start, tokenCount: (data.usage as { total_tokens: number })?.total_tokens, raw: data, strategy: strategy || "" };
        }
        case "gemini": {
          const key = env.GEMINI_API_KEY ?? "";
          if (!key) throw new Error("GEMINI_API_KEY not configured");
          const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } }),
            signal: AbortSignal.timeout(60_000)
          });
          if (!resp.ok) throw new Error(`Gemini ${resp.status}: ${await resp.text()}`);
          const data = await resp.json() as Record<string, unknown>;
          const msg = ((data.candidates as Array<{ content: { parts: Array<{ text: string }> } }>)?.[0]?.content?.parts?.[0]?.text) ?? "";
          const meta = data.usageMetadata as { totalTokenCount?: number } | undefined;
          return { provider, model, response: msg, latencyMs: Date.now() - start, tokenCount: meta?.totalTokenCount, raw: data, strategy: strategy || "" };
        }
        case "huggingface": {
          const key = env.HF_API_KEY ?? env.HUGGINGFACE_API_KEY ?? "";
          if (!key) throw new Error("HF_API_KEY not configured");
          const resp = await fetch(`https://api-inference.huggingface.co/models/${model}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: JSON.stringify({ inputs: prompt, parameters: { max_new_tokens: 1024 } }),
            signal: AbortSignal.timeout(60_000)
          });
          if (!resp.ok) throw new Error(`HF ${resp.status}: ${await resp.text()}`);
          const data = await resp.json() as Record<string, unknown> | Array<Record<string, unknown>>;
          const content = Array.isArray(data) && data.length > 0 ? ((data[0] as Record<string, unknown>).generated_text as string) ?? JSON.stringify(data) : JSON.stringify(data);
          return { provider, model, response: content, latencyMs: Date.now() - start, raw: data, strategy: strategy || "", tokenCount: undefined };
        }
        default:
          throw new Error(`unsupported provider: ${provider}`);
      }
    }

    app.get("/api/v1/prompt-engine/options", async (request) => {
      requirePermission(request, "dashboard:read");
      return { platforms: supportedPlatforms() };
    });
    app.post("/api/v1/prompt-engine/optimise", async (request) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const platform = boundedString(body.platform, "platform", 64) as PromptPlatform;
      if (!supportedPlatforms().some((item) => item.id === platform)) {
        throw new TypeError("platform is not supported.");
      }
      return optimisePromptWithTransform({
        intent: boundedString(body.intent, "intent", 8_000),
        model: boundedString(body.model, "model", 120),
        platform
      });
    });
    app.post("/api/v1/prompt-engine/armory", async (request) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const model = boundedString(body.model ?? "claude-sonnet-4", "model", 120);
      const intent = boundedString(body.intent, "intent", 8_000);
      const { generateArmory } = await import("./prompt-engine.js");
      const armory = generateArmory({ intent, model, platform: "openai" });
      return armory;
    });
    app.get("/api/v1/prompt-engine/models", async (request) => {
      requirePermission(request, "dashboard:read");
      const { MODEL_REGISTRY, listModelsByProvider } = await import("./prompt-engine.js");
      return { models: MODEL_REGISTRY, byProvider: listModelsByProvider() };
    });
    // ---- AI Playground ----
    app.get("/api/v1/playground/providers", async (request) => {
      requirePermission(request, "dashboard:read");
      return {
        providers: {
          venice: { label: "Venice.ai (uncensored)", models: ["venice-uncensored", "llama-3.3-70b", "hermes-3-llama-3.1-405b", "llama-3.2-3b"] },
          openrouter: { label: "OpenRouter (sovereign)", models: ["cognitivecomputations/dolphin-2.9-llama3-8b:free", "meta-llama/llama-3-8b:free", "mistralai/mistral-7b:free"] },
          groq: { label: "Groq", models: ["llama-3-70b-versatile", "mixtral-8x7b-32768"] },
          gemini: { label: "Gemini Flash", models: ["gemini-1.5-flash"] },
          huggingface: { label: "HuggingFace", models: ["mistralai/Mistral-7B-Instruct-v0.3"] },
        }
      };
    });
    app.post("/api/v1/playground/run", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const provider = boundedString(body.provider, "provider", 32);
      const model = boundedString(body.model, "model", 120);
      const intent = boundedString(body.intent, "intent", 8_000);
      const strategy = optionalBoundedString(body.strategy, "strategy", 32) ?? "";
      const stealthEval = String(body.stealthEval ?? "") === "true";
      try {
        const result = await runPlayground(provider, model, intent, strategy, process.env);
        let stealth: unknown = undefined;
        if (stealthEval) {
          const agentUrl = process.env.A1_MAC_STUDIO_ADDRESS ?? "http://100.73.87.122:11434";
          const { evaluateStealth } = await import("./prompt-engine.js");
          stealth = await evaluateStealth(result.response, agentUrl);
          const score = (stealth as { stealthScore?: number }).stealthScore;
          if (providerHealth[provider]) {
            const h = providerHealth[provider]!;
            providerHealth[provider] = {
              flagged: score !== undefined && score < 60,
              lastScore: score ?? 50,
              lastCheck: Date.now(),
              deprioritized: h.deprioritized,
            };
          }
        }
        return reply.status(200).send({ ...result, stealth: stealth ?? undefined });
      } catch (error: unknown) {
        return reply.status(502).send({ error: errorMessage(error), provider, model });
      }
    });
    // ---- Stealth evaluation ----
    app.post("/api/v1/prompt-engine/stealth", async (request) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const intent = boundedString(body.intent, "intent", 8_000);
      const model = optionalBoundedString(body.model, "model", 120) ?? "llama-3.1-8b";
      const agentUrl = process.env.A1_MAC_STUDIO_ADDRESS ?? "http://100.73.87.122:11434";
      const { autoRecurse, evaluateStealth } = await import("./prompt-engine.js");
      const result = await autoRecurse(intent, model, agentUrl);
      return result;
    });
    app.get("/api/v1/playground/health", async (request) => {
      requirePermission(request, "dashboard:read");
      return { providers: providerHealth };
    });
    // ---- API Key Manager ----
    app.get("/api/v1/keys/status", async (request) => {
      requirePermission(request, "dashboard:read");
      const providers = [
        { id: "venice",    label: "Venice.ai",        envKey: "VENICE_API_KEY",        balanceUrl: null },
        { id: "openrouter",label: "OpenRouter",        envKey: "OPENROUTER_API_KEY",    balanceUrl: "https://openrouter.ai/api/v1/credits" },
        { id: "groq",      label: "Groq",              envKey: "GROQ_API_KEY",          balanceUrl: null },
        { id: "gemini",    label: "Gemini",            envKey: "GEMINI_API_KEY",        balanceUrl: null },
        { id: "replicate", label: "Replicate",         envKey: "REPLICATE_API_TOKEN",   balanceUrl: null },
        { id: "huggingface",label: "HuggingFace",      envKey: "HF_API_KEY",            balanceUrl: null },
        { id: "grok",      label: "Grok (xAI)",        envKey: "GROK_API_KEY",          balanceUrl: null },
        { id: "deepseek",  label: "DeepSeek",          envKey: "DEEPSEEK_API_KEY",      balanceUrl: null },
        { id: "uncensored",label: "Uncensored AI",     envKey: "UNCENSORED_AI_KEY",    balanceUrl: null },
        { id: "brave",     label: "Brave Search",     envKey: "BRAVE_API_KEY",        balanceUrl: null },
      ];
      const results = await Promise.all(providers.map(async (p) => {
        const key = process.env[p.envKey] ?? "";
        const configured = key.length > 0;
        let balance: string | null = null;
        let credits: number | null = null;
        if (configured && p.balanceUrl) {
          try {
            const resp = await fetch(p.balanceUrl, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(8_000)
            });
            if (resp.ok) {
              const data = await resp.json() as Record<string, unknown>;
              if (p.id === "openrouter") {
                const d = (data.data as { total_credits?: number; total_usage?: number }) ?? data;
                credits = (d.total_credits ?? 0) - (d.total_usage ?? 0);
                balance = credits != null ? `$${(credits / 1000).toFixed(2)}` : null;
              }
            }
          } catch { /* balance check failed, show unknown */ }
        }
        return { id: p.id, label: p.label, configured, keyPreview: configured ? key.slice(0,8) + '…' : '', balance, credits };
      }));
      return { keys: results };
    });
    // ---- MCP Multi-Node Bridge ----
    app.get("/api/v1/mcp/tools", async (request) => {
      requirePermission(request, "dashboard:read");
      const tools = getTools();
      return {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          node: t.node,
          category: t.category,
          requiresApproval: t.requiresApproval,
          inputSchema: t.inputSchema
        }))
      };
    });
    app.get("/api/v1/mcp/nodes", async (request) => {
      requirePermission(request, "dashboard:read");
      const nodes = await refreshNodeStatus();
      return { nodes };
    });
    app.post("/api/v1/mcp/nodes/refresh", async (request) => {
      requirePermission(request, "dashboard:read");
      const nodes = await refreshNodeStatus();
      return { nodes };
    });
    app.get("/api/v1/mcp/logs", async (request) => {
      requirePermission(request, "dashboard:read");
      const logs = getLogs();
      return { logs };
    });
    app.get("/api/v1/mcp/approval/pending", async (request) => {
      requirePermission(request, "dashboard:read");
      const pending = getPendingApprovals();
      return { approvals: pending };
    });
    app.post<{ Params: { id: string } }>("/api/v1/mcp/approval/:id/approve", async (request) => {
      requirePermission(request, "dashboard:read");
      const req = approveExecution(request.params.id);
      if (!req) return { ok: false, reason: "not found or already processed" };
      // Execute the approved tool
      const body = req;
      const tools = getTools();
      const tool = tools.find((t) => t.name === body.toolName);
      if (!tool) return { ok: false, reason: `unknown tool: ${body.toolName}` };
      const exec = await executeTool(body.toolName, body.arguments, false);
      return { ok: true, result: exec.result, isError: exec.isError };
    });
    app.post<{ Params: { id: string } }>("/api/v1/mcp/approval/:id/deny", async (request) => {
      requirePermission(request, "dashboard:read");
      const req = denyExecution(request.params.id);
      return { ok: req !== null };
    });
    app.post<{ Params: { toolName: string } }>("/api/v1/mcp/tools/:toolName/execute", async (request) => {
      requirePermission(request, "dashboard:read");
      const body = request.body as Record<string, unknown> | undefined;
      const args = (body && typeof body === "object" && !Array.isArray(body)) ? body : {};
      const hitl = body?.hitlEnabled === true || body?.hitlEnabled === "true";
      const result = await executeTool(request.params.toolName, args as Record<string, unknown>, hitl);
      return result;
    });
    // ---- Concierge Custom System Prompt ----
    app.get("/api/v1/concierge/system-prompt", async (request) => {
      requirePermission(request, "dashboard:read");
      try {
        const data = await readFile(conciergePromptPath, "utf-8");
        const parsed = JSON.parse(data) as { prompt: string };
        return { prompt: typeof parsed.prompt === "string" ? parsed.prompt : "" };
      } catch {
        return { prompt: "" };
      }
    });
    app.post("/api/v1/concierge/system-prompt", async (request) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const prompt = typeof body.prompt === "string" ? body.prompt : "";
      if (prompt.length === 0) {
        try { await import("node:fs/promises").then((m) => m.unlink(conciergePromptPath)); } catch {}
        return { ok: true, cleared: true };
      }
      await writeFile(conciergePromptPath, JSON.stringify({ prompt, updatedAt: new Date().toISOString() }), "utf-8");
      return { ok: true };
    });
    // ---- Prompt Library ----
    app.get("/api/v1/prompt-engine/library", async (request) => {
      requirePermission(request, "dashboard:read");
      const entries = await readJsonFile(promptLibraryPath, validateLibraryEntry);
      return { entries };
    });
    app.post("/api/v1/prompt-engine/library", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const now = new Date().toISOString();
      const entry: PromptLibraryEntry = {
        id: randomUUID(),
        name: boundedString(body.name, "name", 256),
        prompt: boundedString(body.prompt, "prompt", 8_000),
        model: boundedString(body.model, "model", 120),
        platform: boundedString(body.platform, "platform", 64) as PromptPlatform,
        technique: boundedString(body.technique, "technique", 128),
        notes: optionalBoundedString(body.notes, "notes", 2_000) ?? "",
        tags: Array.isArray(body.tags) ? (body.tags as string[]).filter((t): t is string => typeof t === "string").slice(0, 20) : [],
        createdAt: now,
        updatedAt: now
      };
      const entries = [entry, ...(await readJsonFile(promptLibraryPath, validateLibraryEntry))].slice(0, 1_000);
      await writeJsonFile(promptLibraryPath, entries);
      return reply.status(201).send({ entry });
    });
    app.delete<{ Params: { id: string } }>("/api/v1/prompt-engine/library/:id", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const entries = await readJsonFile(promptLibraryPath, validateLibraryEntry);
      const filtered = entries.filter((e) => e.id !== request.params.id);
      if (filtered.length === entries.length) {
        return reply.status(404).send({ error: "Not Found", message: "Library entry not found." });
      }
      await writeJsonFile(promptLibraryPath, filtered);
      return reply.status(204).send();
    });

    // ---- Prompt Threads ----
    app.get("/api/v1/prompt-engine/threads", async (request) => {
      requirePermission(request, "dashboard:read");
      const threads = await readJsonFile(promptThreadsPath, validateThread);
      return { threads };
    });
    app.post("/api/v1/prompt-engine/threads", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const now = new Date().toISOString();
      const thread: PromptThread = {
        id: randomUUID(),
        title: boundedString(body.title, "title", 256),
        model: boundedString(body.model, "model", 120),
        platform: boundedString(body.platform, "platform", 64) as PromptPlatform,
        messages: [],
        createdAt: now,
        updatedAt: now
      };
      const threads = [thread, ...(await readJsonFile(promptThreadsPath, validateThread))].slice(0, 500);
      await writeJsonFile(promptThreadsPath, threads);
      return reply.status(201).send({ thread });
    });
    app.post<{ Params: { id: string } }>("/api/v1/prompt-engine/threads/:id/messages", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const now = new Date().toISOString();
      const threads = await readJsonFile(promptThreadsPath, validateThread);
      const index = threads.findIndex((t) => t.id === request.params.id);
      if (index === -1) {
        return reply.status(404).send({ error: "Not Found", message: "Thread not found." });
      }
      const message: PromptThreadMessage = {
        id: randomUUID(),
        role: body.role === "user" || body.role === "engine" ? body.role : "user",
        content: boundedString(body.content, "content", 8_000),
        ...(Array.isArray(body.variants) ? { variants: body.variants } : {}),
        ...(typeof body.transformedIntent === "string" ? { transformedIntent: body.transformedIntent } : {}),
        ...(Array.isArray(body.transformationSteps) ? { transformationSteps: body.transformationSteps } : {}),
        createdAt: now
      };
      const existing = threads[index]!;
      const updated = [...threads] as PromptThread[];
      updated[index] = {
        ...existing,
        messages: [...existing.messages, message].slice(-100),
        updatedAt: now
      };
      await writeJsonFile(promptThreadsPath, updated);
      return reply.status(201).send({ thread: updated[index] });
    });
    app.delete<{ Params: { id: string } }>("/api/v1/prompt-engine/threads/:id", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const threads = await readJsonFile(promptThreadsPath, validateThread);
      const filtered = threads.filter((t) => t.id !== request.params.id);
      if (filtered.length === threads.length) {
        return reply.status(404).send({ error: "Not Found", message: "Thread not found." });
      }
      await writeJsonFile(promptThreadsPath, filtered);
      return reply.status(204).send();
    });

    app.post("/api/v1/studios/history", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      if (!studioKinds.has(body.kind as StudioKind)) {
        throw new TypeError("kind must be image, image_edit, video, or audio.");
      }
      const status = body.status === undefined ? "draft" : body.status;
      if (!studioStatuses.has(status as StudioStatus)) {
        throw new TypeError("status is invalid.");
      }
      const now = new Date().toISOString();
      const referenceName = optionalBoundedString(body.referenceName, "referenceName", 512);
      const entry: StudioHistoryEntry = {
        createdAt: now,
        id: randomUUID(),
        kind: body.kind as StudioKind,
        prompt: boundedString(body.prompt, "prompt", 8_000),
        ...(referenceName === undefined ? {} : { referenceName }),
        status: status as StudioStatus,
        title: boundedString(body.title, "title", 180),
        updatedAt: now
      };
      const entries = [entry, ...(await readStudioHistory(studioHistoryPath))].slice(0, 500);
      await writeStudioHistory(studioHistoryPath, entries);
      return reply.status(201).send({ entry });
    });

    app.post("/api/v1/studios/generate", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const token = replicateApiToken;
      if (!token) {
        return reply.status(503).send({ error: "Unavailable", message: "Replicate API token not configured on the VPS." });
      }
      const body = objectBody(request.body);
      const prompt = boundedString(body.prompt, "prompt", 4_000);
      const model = boundedString(body.model ?? "sdxl", "model", 64);
      const width = Math.min(Math.max(Number(body.width) || 1024, 256), 1440);
      const height = Math.min(Math.max(Number(body.height) || 1024, 256), 1440);
      const steps = Math.min(Math.max(Number(body.steps) || 1, 1), 50);

      const resolveModel = (name: string): { version: string; label: string } => {
        switch (name) {
          case "flux-schnell": return { version: "black-forest-labs/flux-schnell", label: "flux-schnell" };
          case "flux-dev":     return { version: "black-forest-labs/flux-dev", label: "flux-dev" };
          case "sdxl":         return { version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b", label: "sdxl" };
          case "sd3":          return { version: "stability-ai/stable-diffusion-3", label: "sd3" };
          default:             return { version: "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b", label: "sdxl" };
        }
      };
      const { version: modelVersion, label: modelLabel } = resolveModel(model);

      request.log.info({ model: modelLabel, prompt: prompt.slice(0, 80) }, "Starting Replicate generation");

      const t0 = Date.now();
      const input: Record<string, unknown> = { prompt, width, height, num_inference_steps: steps };
      if (model === "flux-schnell") {
        input.num_outputs = 1;
        input.aspect_ratio = "1:1";
        delete input.num_inference_steps;
        delete input.width;
        delete input.height;
      }

      // Use the general predictions endpoint with version field
      let resp = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ version: modelVersion, input }),
      });
      if (!resp.ok) {
        const err = await resp.text();
        if (resp.status === 401) return reply.status(502).send({ error: "Bad Gateway", message: "Invalid Replicate token." });
        if (resp.status === 402) return reply.status(402).send({ error: "Payment Required", message: "Replicate quota exceeded." });
        return reply.status(502).send({ error: "Bad Gateway", message: err.slice(0, 300) });
      }
      const prediction = (await resp.json()) as { id: string; status: string; output?: string[]; error?: string; urls?: { get: string } };

      // Poll until complete
      const pollUrl = prediction.urls?.get ?? `https://api.replicate.com/v1/predictions/${prediction.id}`;
      let attempts = 0;
      while (attempts < 30) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const pr = await fetch(pollUrl, { headers: { "Authorization": `Bearer ${token}` } });
        if (!pr.ok) throw new Error(`Poll failed: ${String(pr.status)}`);
        const p = (await pr.json()) as { status: string; output?: string[]; error?: string; logs?: string };
        if (p.status === "succeeded" && p.output?.[0]) {
          const url = p.output[0];
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          request.log.info({ model: modelVersion, elapsed }, "Replicate generation complete");
          const title = boundedString(body.title ?? "", "title", 256) || prompt.slice(0, 60);
          const now = new Date().toISOString();
          const kind = (body.kind === "image_edit" ? "image_edit" : "image") as StudioKind;
          const refName = optionalBoundedString(body.referenceName, "referenceName", 512);
          const studioEntry: StudioHistoryEntry = {
            id: randomUUID(), title, prompt, kind, status: "completed",
            ...(refName !== undefined ? { referenceName: refName } : {}),
            createdAt: now, updatedAt: now, model: modelLabel, resultUrl: url, elapsed,
          };
          const history = [studioEntry, ...(await readStudioHistory(studioHistoryPath))].slice(0, 500);
          await writeStudioHistory(studioHistoryPath, history);
          return reply.send({ url, model: modelLabel, elapsed, entry: studioEntry });
        }
        if (p.status === "failed") return reply.status(502).send({ error: "Generation Failed", message: p.error ?? "Unknown error" });
        if (p.status === "canceled") return reply.status(502).send({ error: "Canceled", message: "Generation was canceled." });
        attempts++;
      }
      return reply.status(504).send({ error: "Timeout", message: "Generation took too long." });
    });

    app.post("/api/v1/studios/extract-audio", async (request, reply) => {
      requirePermission(request, "dashboard:read");
      const body = objectBody(request.body);
      const videoPath = boundedString(body.videoPath, "videoPath", 1024);
      const format = boundedString(body.format ?? "mp3", "format", 8);
      const title = boundedString(body.title ?? "Audio extract", "title", 256);

      if (!["mp3", "wav", "aac", "ogg", "flac"].includes(format)) {
        return reply.status(400).send({ error: "Bad Request", message: "Format must be mp3, wav, aac, ogg, or flac." });
      }

      // Save brief — user runs ffmpeg locally on M1
      const outPath = videoPath.replace(/\.\w+$/, `_audio.${format}`);
      const now = new Date().toISOString();
      const studioEntry: StudioHistoryEntry = {
        id: randomUUID(), title, prompt: `Extract audio from ${videoPath} → ${outPath}`, kind: "audio_extract",
        status: "ready", createdAt: now, updatedAt: now, model: "ffmpeg",
      };
      const history = [studioEntry, ...(await readStudioHistory(studioHistoryPath))].slice(0, 500);
      await writeStudioHistory(studioHistoryPath, history);
      return reply.send({ entry: studioEntry, command: `ffmpeg -i "${videoPath}" -vn -acodec libmp3lame "${outPath}"` });
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
    await access(resolve(staticRoot, "login.html"));
    await app.register(fastifyStatic, {
      index: "login.html",
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
