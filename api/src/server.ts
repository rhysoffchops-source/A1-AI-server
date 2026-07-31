import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  AgentRunner,
  VastAiProvider,
  type AgentDefinition,
  type ComputeProvider
} from "@a1/agents";
import { loadConfig } from "@a1/config";
import {
  ApplicationRuntime,
  assertJsonValue,
  createLogger,
  HealthRegistry,
  InMemoryEventBus,
  type JsonObject,
  type JsonValue
} from "@a1/core";
import { SqliteBackupSource, SqliteTaskStore } from "@a1/databases";
import { McpRegistry, type McpServerConfig } from "@a1/mcp";
import { SqliteMemoryEngine } from "@a1/memory";
import { createModelProvider, ModelCatalog, ModelManager, type ModelProvider } from "@a1/models";
import { MetricsRegistry, NvidiaSmiGpuMonitor } from "@a1/monitoring";
import {
  TaskScheduler,
  type TaskEventMap,
  type TaskExecutionContext,
  type TaskHandler
} from "@a1/orchestrator";
import { PluginManager, type PluginEventMap } from "@a1/plugins";
import { ProjectRegistry, WorkerRegistry } from "@a1/projects";
import {
  ApprovalGate,
  AuditService,
  ChainedFileAuditSink,
  EnvironmentSecretResolver,
  HmacTokenService,
  PermissionAuthorizer
} from "@a1/security";
import { BackupService, createObjectStorage, FileBackupSource } from "@a1/services";
import { ToolRegistry } from "@a1/tools";

import { buildApp } from "./app.js";
import { McpToolBridge } from "./mcp-tools.js";

const config = await loadConfig();
const logger = createLogger({
  environment: config.application.environment,
  level: config.logging.level,
  serviceName: config.application.name,
  version: config.application.version
});
function jsonValue(value: unknown): JsonValue {
  assertJsonValue(value);
  return value;
}
const health = new HealthRegistry(config.server.healthCheckTimeoutMs);
const environmentSecrets = new EnvironmentSecretResolver();
async function resolveSecretReferences(
  values: Readonly<Record<string, string>>
): Promise<Readonly<Record<string, string>>> {
  return Object.fromEntries(
    await Promise.all(
      Object.entries(values).map(async ([key, value]) => {
        if (!value.startsWith("secret://")) return [key, value] as const;
        const handle = value.slice("secret://".length);
        if (handle === "") throw new Error(`Secret reference for "${key}" has an empty handle.`);
        const secret = await environmentSecrets.resolve(handle);
        if (secret === undefined) throw new Error(`Secret "${handle}" is not configured.`);
        return [key, secret] as const;
      })
    )
  );
}
const mcpConfigurations: readonly McpServerConfig[] = await Promise.all(
  config.mcp.servers.map(async (server) =>
    server.transport === "stdio"
      ? { ...server, env: await resolveSecretReferences(server.env) }
      : { ...server, headers: await resolveSecretReferences(server.headers) }
  )
);
const authenticationSecret = config.security.authentication.enabled
  ? await environmentSecrets.resolve(config.security.authentication.tokenSecret)
  : undefined;
if (config.security.authentication.enabled && authenticationSecret === undefined) {
  throw new Error(
    `Authentication secret "${config.security.authentication.tokenSecret}" is not configured.`
  );
}
const tokenService =
  authenticationSecret === undefined
    ? undefined
    : new HmacTokenService({
        audience: config.security.authentication.audience,
        issuer: config.security.authentication.issuer,
        secret: createHash("sha256").update(authenticationSecret).digest(),
        ttlSeconds: config.security.authentication.tokenTtlSeconds
      });
const dashboardPassphrase = process.env.A1_SECRET_DASHBOARD_PASSPHRASE;
const replicateApiToken = process.env.REPLICATE_API_TOKEN;

type A1EventMap = PluginEventMap & TaskEventMap;
const events = new InMemoryEventBus<A1EventMap>();
const audit = new AuditService(
  new ChainedFileAuditSink({
    filePath: config.audit.filePath,
    syncWrites: config.audit.syncWrites
  })
);
const authorizer = new PermissionAuthorizer(
  new Map(
    Object.entries(config.security.rolePermissions).map(([role, permissions]) => [
      role,
      new Set(permissions)
    ])
  )
);
const approvalSecretValue = await environmentSecrets.resolve(config.security.encryptedSecretKey);
const approvalGate = new ApprovalGate(
  approvalSecretValue === undefined
    ? ApprovalGate.generateSecret()
    : createHash("sha256").update(approvalSecretValue).digest(),
  config.security.approvalTtlSeconds
);
const storageProviders = new Map(
  await Promise.all(
    config.storage.providers.map(
      async (provider) =>
        [
          provider.id,
          await createObjectStorage(provider, (handle) => environmentSecrets.resolve(handle))
        ] as const
    )
  )
);
const backupStorage = storageProviders.get(config.storage.backupProviderId);
if (backupStorage === undefined) {
  throw new Error(
    `Backup storage provider "${config.storage.backupProviderId}" is not configured.`
  );
}
if (!storageProviders.has(config.storage.defaultProviderId)) {
  throw new Error(
    `Default storage provider "${config.storage.defaultProviderId}" is not configured.`
  );
}
const backups = new BackupService(backupStorage);
const backupSources = [
  new SqliteBackupSource("scheduler.sqlite", config.scheduler.databasePath),
  new SqliteBackupSource("memory.sqlite", config.memory.databasePath),
  new SqliteBackupSource("projects.sqlite", config.projects.databasePath),
  new FileBackupSource("audit.jsonl", config.audit.filePath)
];
const computeProviders = new Map<string, ComputeProvider>();
for (const provider of config.compute.providers.filter((item) => item.enabled)) {
  const apiKey = await environmentSecrets.resolve(provider.apiKeySecret);
  if (apiKey === undefined) {
    throw new Error(
      `Compute provider "${provider.id}" secret "${provider.apiKeySecret}" is not configured.`
    );
  }
  computeProviders.set(
    provider.id,
    new VastAiProvider({
      apiKey,
      ...(provider.baseUrl === undefined ? {} : { baseUrl: provider.baseUrl }),
      id: provider.id,
      timeoutMs: provider.timeoutMs
    })
  );
}

const memory = new SqliteMemoryEngine({
  busyTimeoutMs: config.memory.databaseBusyTimeoutMs,
  filePath: config.memory.databasePath
});
const mcp = new McpRegistry(mcpConfigurations, new Set(config.mcp.grantedPermissions));
const tools = new ToolRegistry(authorizer, audit);
tools.register({
  description: "Echo input back — useful for confirming arguments before execution.",
  execute: (_context, input) => Promise.resolve(input),
  inputSchema: {
    properties: { text: { description: "The text to echo back.", type: "string" } },
    required: ["text"],
    type: "object"
  },
  name: "echo",
  parse: (input) => input,
  permission: "tool:echo"
});
tools.register({
  description:
    "Execute a shell command and return stdout, stderr, and exit code. Use for system operations, file checks, process management, and gathering system information.",
  execute: async (_context, input): Promise<JsonValue> => {
    const cmd = typeof input.command === "string" ? input.command : "";
    if (cmd.trim() === "") throw new TypeError("Shell command must be a non-empty string.");
    const cwd = typeof input.cwd === "string" ? input.cwd : undefined;
    const timeoutMs = typeof input.timeoutMs === "number" ? input.timeoutMs : 30_000;
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      const child = execFile(
        "/bin/sh",
        ["-c", cmd],
        { cwd, maxBuffer: 1024 * 1024, timeout: timeoutMs },
        (error, stdout, stderr) => {
          resolve({
            exitCode: (error as NodeJS.ErrnoException | null)?.code ?? 0,
            stderr: stderr.trimEnd(),
            stdout: stdout.trimEnd()
          });
        }
      );
      child.on("error", (err) => resolve({ exitCode: -1, stderr: String(err), stdout: "" }));
    });
  },
  inputSchema: {
    properties: {
      command: { description: "Shell command to execute via /bin/sh -c.", type: "string" },
      cwd: { description: "Working directory for the command.", type: "string" },
      timeoutMs: { description: "Command timeout in milliseconds.", type: "number" }
    },
    required: ["command"],
    type: "object"
  },
  name: "shell",
  parse: (input) => input,
  permission: "tool:shell"
});
tools.register({
  description:
    "Read a file from the filesystem. Returns the file contents as a string. Use for inspecting logs, configs, code, and data files.",
  execute: async (_context, input): Promise<JsonValue> => {
    const filePath = input.path;
    if (typeof filePath !== "string" || filePath.trim() === "")
      throw new TypeError("File path must be a non-empty string.");
    const { readFile } = await import("node:fs/promises");
    const content = await readFile(filePath, "utf8");
    const maxBytes = typeof input.maxBytes === "number" ? input.maxBytes : 65536;
    return {
      content: content.slice(0, maxBytes),
      truncated: Buffer.byteLength(content, "utf8") > maxBytes
    };
  },
  inputSchema: {
    properties: {
      maxBytes: { description: "Maximum bytes to return.", type: "number" },
      path: { description: "Absolute path to the file to read.", type: "string" }
    },
    required: ["path"],
    type: "object"
  },
  name: "read_file",
  parse: (input) => input,
  permission: "tool:filesystem"
});
tools.register({
  description:
    "Write content to a file. Creates parent directories if needed. Use for saving generated code, logs, configs, or notes.",
  execute: async (_context, input): Promise<JsonValue> => {
    const filePath = input.path;
    const content = input.content;
    if (typeof filePath !== "string" || filePath.trim() === "")
      throw new TypeError("File path must be a non-empty string.");
    if (typeof content !== "string") throw new TypeError("File content must be a string.");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const nodePath = await import("node:path");
    await mkdir(nodePath.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf8");
    return { path: filePath, written: Buffer.byteLength(content, "utf8") };
  },
  inputSchema: {
    properties: {
      content: { description: "Content to write to the file.", type: "string" },
      path: { description: "Absolute path to write to.", type: "string" }
    },
    required: ["path", "content"],
    type: "object"
  },
  name: "write_file",
  parse: (input) => input,
  permission: "tool:filesystem"
});
tools.register({
  description:
    "List files in a directory. Returns names and types. Use for exploring projects, finding files, and understanding directory structure.",
  execute: async (_context, input): Promise<JsonValue> => {
    const dir = input.path;
    if (typeof dir !== "string" || dir.trim() === "")
      throw new TypeError("Directory path must be a non-empty string.");
    const { readdir, stat } = await import("node:fs/promises");
    const entries = await readdir(dir);
    const result = await Promise.all(
      entries.map(async (name) => {
        try {
          const s = await stat(`${dir}/${name}`);
          return { name, type: s.isDirectory() ? "directory" : s.isFile() ? "file" : "other" };
        } catch {
          return { name, type: "unknown" };
        }
      })
    );
    return { entries: result, path: dir };
  },
  inputSchema: {
    properties: {
      path: { description: "Directory path to list.", type: "string" }
    },
    required: ["path"],
    type: "object"
  },
  name: "list_dir",
  parse: (input) => input,
  permission: "tool:filesystem"
});
const modelCatalog = new ModelCatalog();
for (const model of config.models.catalog) {
  modelCatalog.register({ ...model, capabilities: new Set(model.capabilities) });
}
const modelManager = new ModelManager(modelCatalog);
const modelProviders: ModelProvider[] = [];
for (const providerConfiguration of config.models.providers.filter(
  (provider) => provider.enabled
)) {
  const apiKey =
    providerConfiguration.apiKeySecret === undefined
      ? undefined
      : await environmentSecrets.resolve(providerConfiguration.apiKeySecret);
  if (providerConfiguration.apiKeySecret !== undefined && apiKey === undefined) {
    throw new Error(
      `Model provider "${providerConfiguration.id}" secret "${providerConfiguration.apiKeySecret}" is not configured.`
    );
  }
  const secretHeaders = Object.fromEntries(
    await Promise.all(
      Object.entries(providerConfiguration.headerSecrets).map(async ([header, secretHandle]) => {
        const value = await environmentSecrets.resolve(secretHandle);
        if (value === undefined) {
          throw new Error(
            `Model provider "${providerConfiguration.id}" header secret "${secretHandle}" is not configured.`
          );
        }
        return [header, value] as const;
      })
    )
  );
  const provider = createModelProvider(
    {
      baseUrl: providerConfiguration.baseUrl,
      defaultHeaders: { ...providerConfiguration.headers, ...secretHeaders },
      id: providerConfiguration.id,
      timeoutMs: providerConfiguration.timeoutMs,
      type: providerConfiguration.type
    },
    apiKey
  );
  modelManager.registerProvider(provider);
  modelProviders.push(provider);
}

const agentDefinitions: readonly AgentDefinition[] = config.agents.definitions.map(
  (definition) => ({
    ...definition,
    modelCapabilities: new Set(definition.modelCapabilities),
    permissions: new Set(definition.permissions)
  })
);
const agentRunner = new AgentRunner(modelManager, memory, tools);
const workerId = `${config.application.name}-${String(process.pid)}-${randomUUID()}`;
const scheduler = new TaskScheduler({
  audit,
  claimBatchSize: config.scheduler.claimBatchSize,
  defaultMaxAttempts: config.scheduler.defaultMaxAttempts,
  defaultTaskTimeoutMs: config.scheduler.defaultTaskTimeoutMs,
  events,
  leaseDurationMs: config.scheduler.leaseDurationMs,
  logger,
  maxConcurrency: config.scheduler.maxConcurrency,
  pollIntervalMs: config.scheduler.pollIntervalMs,
  retryBaseDelayMs: config.scheduler.retryBaseDelayMs,
  retryJitter: config.scheduler.retryJitter,
  retryMaxDelayMs: config.scheduler.retryMaxDelayMs,
  store: new SqliteTaskStore({
    busyTimeoutMs: config.scheduler.databaseBusyTimeoutMs,
    filePath: config.scheduler.databasePath
  }),
  workerId
});
const agentTaskHandler: TaskHandler<JsonObject> = {
  execute: async (context: TaskExecutionContext, payload: JsonObject): Promise<JsonValue> => {
    const agentId = payload.agentId;
    const input = payload.input;
    if (typeof agentId !== "string" || typeof input !== "string") {
      throw new TypeError("Agent task payload is invalid.");
    }
    const definition = agentDefinitions.find((agent) => agent.id === agentId);
    if (definition === undefined) throw new Error(`Agent "${agentId}" is not configured.`);

    // Check for custom concierge system prompt
    let systemPrompt = definition.systemPrompt;
    if (agentId === "concierge") {
      try {
        const promptPath = resolve("/opt/a1/data/runtime", "concierge-prompt.json");
        const data = JSON.parse(await readFile(promptPath, "utf-8")) as { prompt?: string };
        if (data.prompt && data.prompt.trim().length > 0) systemPrompt = data.prompt;
      } catch { /* no custom prompt file, use default */ }
    }

    const effectiveDefinition = { ...definition, systemPrompt };
    const result = await agentRunner.run(effectiveDefinition, input, context.signal);
    return {
      agentId: result.agentId,
      conversationId: result.conversationId,
      output: result.output,
      runId: result.runId,
      steps: result.steps
    };
  },
  kind: "agent.run",
  parse: (payload: JsonValue): JsonObject => {
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("Agent task payload must be an object.");
    }
    return payload as JsonObject;
  }
};
scheduler.registerHandler(agentTaskHandler);

const projects = new ProjectRegistry({
  busyTimeoutMs: config.projects.databaseBusyTimeoutMs,
  filePath: config.projects.databasePath
});
const workerTokens = new Map<string, string>(
  await Promise.all(
    config.workers.definitions.map(async (worker) => {
      const token = await environmentSecrets.resolve(worker.tokenSecret);
      if (token === undefined) {
        throw new Error(`Worker "${worker.id}" secret "${worker.tokenSecret}" is not configured.`);
      }
      return [worker.id, token] as const;
    })
  )
);
const workers = new WorkerRegistry({
  busyTimeoutMs: config.workers.databaseBusyTimeoutMs,
  definitions: config.workers.definitions.map((worker) => ({
    allowedRoots: worker.allowedRoots,
    id: worker.id,
    name: worker.name,
    platform: worker.platform
  })),
  filePath: config.workers.databasePath
});
tools.register({
  description:
    "List enrolled A1 workers and their latest heartbeat. Use before delegating work to the M1, Intel, or Vast environment.",
  execute: async (): Promise<JsonValue> => jsonValue({ workers: await workers.list() }),
  inputSchema: {
    properties: {},
    type: "object"
  },
  name: "worker_status",
  parse: (input) => input,
  permission: "worker:read"
});
tools.register({
  description:
    "Queue a remote worker command. project.verify and system.inspect are safe checks. shell runs only when that worker explicitly enables it and always remains inside its configured project roots.",
  execute: async (_context, input): Promise<JsonValue> => {
    const workerId = input.workerId;
    const kind = input.kind;
    const payload = input.payload;
    if (typeof workerId !== "string" || workerId.trim() === "") {
      throw new TypeError("workerId must be a non-empty string.");
    }
    if (kind !== "project.verify" && kind !== "shell" && kind !== "system.inspect") {
      throw new TypeError("kind must be project.verify, shell, or system.inspect.");
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new TypeError("payload must be an object.");
    }
    assertJsonValue(payload, "worker command payload");
    return jsonValue({
      command: await workers.queue({
        kind,
        payload: payload as JsonObject,
        workerId
      })
    });
  },
  inputSchema: {
    properties: {
      kind: {
        description: "One of project.verify, system.inspect, or shell.",
        type: "string"
      },
      payload: {
        description:
          "Command input. project.verify and shell require a path or cwd inside the worker's configured roots.",
        type: "object"
      },
      workerId: { description: "The enrolled worker ID.", type: "string" }
    },
    required: ["workerId", "kind", "payload"],
    type: "object"
  },
  name: "worker_command",
  parse: (input) => input,
  permission: "worker:execute"
});
tools.register({
  description: "Read the current status and result of a command queued for an enrolled worker.",
  execute: async (_context, input): Promise<JsonValue> => {
    const workerId = input.workerId;
    const commandId = input.commandId;
    if (typeof workerId !== "string" || workerId.trim() === "") {
      throw new TypeError("workerId must be a non-empty string.");
    }
    if (typeof commandId !== "string" || commandId.trim() === "") {
      throw new TypeError("commandId must be a non-empty string.");
    }
    return jsonValue({ command: (await workers.getCommand(workerId, commandId)) ?? null });
  },
  inputSchema: {
    properties: {
      commandId: { description: "Queued command ID.", type: "string" },
      workerId: { description: "The enrolled worker ID.", type: "string" }
    },
    required: ["workerId", "commandId"],
    type: "object"
  },
  name: "worker_command_status",
  parse: (input) => input,
  permission: "worker:read"
});
tools.register({
  description:
    "List watched projects and their current verification state. Treat unverified, queued, running, or failed code as not ready to pass.",
  execute: async (): Promise<JsonValue> => jsonValue({ projects: await workers.listProjects() }),
  inputSchema: {
    properties: {},
    type: "object"
  },
  name: "code_verification_status",
  parse: (input) => input,
  permission: "worker:read"
});
tools.register({
  description:
    "Record the Code Watchdog's structured decision for an exact project code fingerprint. A blocked decision prevents A1 write commands in that project until an explicit unlock workflow is completed.",
  execute: async (_context, input): Promise<JsonValue> => {
    const workerId = input.workerId;
    const path = input.path;
    const fingerprint = input.fingerprint;
    const status = input.status;
    const summary = input.summary;
    const findings = input.findings;
    if (typeof workerId !== "string" || workerId.trim() === "") {
      throw new TypeError("workerId must be a non-empty string.");
    }
    if (typeof path !== "string" || path.trim() === "") {
      throw new TypeError("path must be a non-empty string.");
    }
    if (typeof fingerprint !== "string" || fingerprint.trim() === "") {
      throw new TypeError("fingerprint must be a non-empty string.");
    }
    if (status !== "approved" && status !== "blocked" && status !== "fix_required") {
      throw new TypeError("status must be approved, fix_required, or blocked.");
    }
    if (typeof summary !== "string" || summary.trim() === "") {
      throw new TypeError("summary must be a non-empty string.");
    }
    if (findings === null || typeof findings !== "object" || Array.isArray(findings)) {
      throw new TypeError("findings must be an object.");
    }
    assertJsonValue(findings, "code watchdog findings");
    const decision = await workers.recordReview({
      findings: findings as JsonObject,
      fingerprint,
      path,
      status,
      summary,
      workerId
    });
    return jsonValue({
      cancelledWriteCommands: decision.cancelledWriteCommands,
      ...(decision.lockCommand === undefined ? {} : { lockCommand: decision.lockCommand }),
      project: decision.project
    });
  },
  inputSchema: {
    properties: {
      findings: { description: "Structured violations and remediation details.", type: "object" },
      fingerprint: { description: "Exact watched code fingerprint.", type: "string" },
      path: { description: "Absolute project path on the worker.", type: "string" },
      status: { description: "approved, fix_required, or blocked.", type: "string" },
      summary: { description: "Short decision and reason.", type: "string" },
      workerId: { description: "Enrolled worker ID.", type: "string" }
    },
    required: ["workerId", "path", "fingerprint", "status", "summary", "findings"],
    type: "object"
  },
  name: "code_watchdog_decision",
  parse: (input) => input,
  permission: "code:watchdog"
});
const pluginManager = new PluginManager({
  a1ApiVersion: config.plugins.a1ApiVersion,
  audit,
  events,
  grantedPermissions: new Set(config.plugins.grantedPermissions),
  logger
});
const mcpToolBridge = new McpToolBridge(mcpConfigurations, mcp, tools);
const gpu = new NvidiaSmiGpuMonitor();
const metrics = new MetricsRegistry();
const runtime = new ApplicationRuntime();
runtime.register(audit);
runtime.register(memory);
runtime.register(mcp);
runtime.register(mcpToolBridge);
runtime.register(projects);
runtime.register(workers);
runtime.register(scheduler);
runtime.register(pluginManager);
health.register("audit", () => audit.health());
health.register("memory", () => memory.health());
health.register("mcp", () => mcp.health());
health.register("projects", () => projects.health());
health.register("workers", () => workers.health());
health.register("scheduler", () => scheduler.health());
health.register("plugins", () => pluginManager.health());
for (const provider of modelProviders) {
  health.register(
    `model:${provider.id}`,
    async () => ({
      message: `Model provider ${provider.id}`,
      status: (await provider.health()) ? "healthy" : "unhealthy"
    }),
    { required: false }
  );
}
for (const [id, storage] of storageProviders) {
  health.register(
    `storage:${id}`,
    async () => {
      await storage.list("a1-health");
      return { status: "healthy" };
    },
    { required: id === config.storage.defaultProviderId || id === config.storage.backupProviderId }
  );
}
const app = await buildApp({
  config,
  control: {
    agents: agentDefinitions,
    approvalGate,
    authorizer,
    backupSources,
    backups,
    compute: computeProviders,
    events,
    gpu,
    memory,
    metrics,
    models: modelCatalog,
    plugins: pluginManager,
    projects,
    scheduler,
    workers
  },
  health,
  logger,
  ...(tokenService === undefined ? {} : { tokenService }),
  ...(dashboardPassphrase === undefined ? {} : { dashboardPassphrase }),
  ...(replicateApiToken === undefined ? {} : { replicateApiToken }),
  workerTokens
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise !== undefined) return shutdownPromise;
  shutdownPromise = (async () => {
    logger.info({ signal }, "Shutdown requested");
    const deadline = setTimeout(() => {
      logger.fatal(
        { timeoutMs: config.server.shutdownTimeoutMs },
        "Graceful shutdown deadline exceeded"
      );
      process.exit(1);
    }, config.server.shutdownTimeoutMs);
    deadline.unref();
    try {
      await app.close();
      try {
        await audit.record({
          action: "system.stop",
          actor: { id: workerId, kind: "service" },
          metadata: { signal, version: config.application.version },
          outcome: "success",
          severity: "info",
          target: { id: config.application.name, type: "service" }
        });
      } catch (auditError: unknown) {
        logger.error({ err: auditError }, "Failed to record shutdown audit event");
        process.exitCode = 1;
      }
      await runtime.stop();
      logger.info("A1 control plane stopped");
    } catch (error: unknown) {
      logger.error({ err: error }, "A1 control plane failed to stop cleanly");
      process.exitCode = 1;
    } finally {
      clearTimeout(deadline);
    }
  })();
  return shutdownPromise;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void shutdown(signal));
}
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception");
  process.exitCode = 1;
  void shutdown("SIGTERM");
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "Unhandled promise rejection");
  process.exitCode = 1;
  void shutdown("SIGTERM");
});

try {
  await runtime.start();
  const address = await app.listen({ host: config.server.host, port: config.server.port });
  await audit.record({
    action: "system.start",
    actor: { id: workerId, kind: "service" },
    metadata: { version: config.application.version },
    outcome: "success",
    severity: "info",
    target: { id: config.application.name, type: "service" }
  });
  logger.info({ address }, "A1 control plane started");
} catch (error: unknown) {
  logger.fatal({ err: error }, "A1 control plane failed to start");
  process.exitCode = 1;
  await app.close();
  try {
    await runtime.stop();
  } catch (shutdownError: unknown) {
    logger.error({ err: shutdownError }, "A1 runtime rollback failed");
  }
}
