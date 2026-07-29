import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { A1Config } from "@a1/config";
import { createLogger, HealthRegistry, InMemoryEventBus } from "@a1/core";
import { SqliteTaskStore } from "@a1/databases";
import { SqliteMemoryEngine } from "@a1/memory";
import { ModelCatalog } from "@a1/models";
import { MetricsRegistry, type GpuMonitor } from "@a1/monitoring";
import { TaskScheduler, type TaskEventMap } from "@a1/orchestrator";
import { PluginManager, type PluginEventMap } from "@a1/plugins";
import { ProjectRegistry, WorkerRegistry } from "@a1/projects";
import {
  ApprovalGate,
  PermissionAuthorizer,
  type AuditEnvelope,
  type AuditInput,
  type AuditRecorder
} from "@a1/security";
import { BackupService, LocalObjectStorage } from "@a1/services";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

async function within<T>(label: string, operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} did not complete.`)), 2_000);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function auditRecorder(): AuditRecorder {
  return {
    record: (input: AuditInput) =>
      Promise.resolve({
        ...input,
        id: randomUUID(),
        metadata: input.metadata ?? {},
        occurredAt: new Date().toISOString()
      } as AuditEnvelope)
  };
}

describe("control-plane API", () => {
  it("serves dashboard state and persists projects and backups", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-control-api-"));
    const config = {
      agents: { definitions: [] },
      audit: { filePath: join(directory, "audit.jsonl"), syncWrites: false },
      application: { environment: "test", name: "a1-test", version: "1.0.0" },
      compute: { providers: [] },
      logging: { level: "fatal" },
      mcp: { grantedPermissions: [], servers: [] },
      memory: {
        databaseBusyTimeoutMs: 1_000,
        databasePath: join(directory, "memory.sqlite"),
        defaultSearchLimit: 20
      },
      models: { catalog: [], providers: [] },
      monitoring: { gpu: { enabled: true } },
      plugins: { a1ApiVersion: "1.0.0", grantedPermissions: [] },
      projects: {
        databaseBusyTimeoutMs: 1_000,
        databasePath: join(directory, "projects.sqlite")
      },
      scheduler: {
        claimBatchSize: 4,
        databaseBusyTimeoutMs: 1_000,
        databasePath: join(directory, "tasks.sqlite"),
        defaultMaxAttempts: 3,
        defaultTaskTimeoutMs: 1_000,
        leaseDurationMs: 1_000,
        maxConcurrency: 2,
        pollIntervalMs: 10,
        retryBaseDelayMs: 10,
        retryJitter: 0,
        retryMaxDelayMs: 100
      },
      security: {
        approvalTtlSeconds: 300,
        authentication: {
          audience: "a1-api",
          enabled: false,
          issuer: "a1",
          tokenSecret: "auth.token",
          tokenTtlSeconds: 3_600
        },
        encryptedSecretFilePath: join(directory, "secrets.enc.json"),
        encryptedSecretKey: "secrets.master-key",
        rolePermissions: {}
      },
      server: {
        bodyLimitBytes: 1_048_576,
        healthCheckTimeoutMs: 100,
        host: "127.0.0.1",
        port: 8_787,
        requestTimeoutMs: 1_000,
        shutdownTimeoutMs: 1_000,
        trustProxy: false
      },
      storage: {
        backupProviderId: "local",
        defaultProviderId: "local",
        providers: [{ id: "local", rootPath: join(directory, "objects"), type: "local" }]
      },
      workers: {
        databaseBusyTimeoutMs: 1_000,
        databasePath: join(directory, "workers.sqlite"),
        definitions: []
      }
    } satisfies A1Config;
    type Events = PluginEventMap & TaskEventMap;
    const events = new InMemoryEventBus<Events>();
    const audit = auditRecorder();
    const logger = createLogger({
      environment: "test",
      level: "fatal",
      serviceName: "control-api-test",
      version: "1.0.0"
    });
    const memory = new SqliteMemoryEngine({
      busyTimeoutMs: 1_000,
      filePath: config.memory.databasePath
    });
    const projects = new ProjectRegistry({
      busyTimeoutMs: 1_000,
      filePath: config.projects.databasePath
    });
    const workers = new WorkerRegistry({
      busyTimeoutMs: 1_000,
      definitions: [],
      filePath: config.workers.databasePath
    });
    const scheduler = new TaskScheduler({
      audit,
      claimBatchSize: 4,
      defaultMaxAttempts: 3,
      defaultTaskTimeoutMs: 1_000,
      events,
      leaseDurationMs: 1_000,
      logger,
      maxConcurrency: 2,
      pollIntervalMs: 10,
      retryBaseDelayMs: 10,
      retryJitter: 0,
      retryMaxDelayMs: 100,
      store: new SqliteTaskStore({
        busyTimeoutMs: 1_000,
        filePath: config.scheduler.databasePath
      }),
      workerId: "test"
    });
    const plugins = new PluginManager({
      a1ApiVersion: "1.0.0",
      audit,
      events,
      grantedPermissions: new Set(),
      logger
    });
    await memory.start();
    await projects.start();
    await workers.start();
    await scheduler.start();
    await plugins.start();
    const health = new HealthRegistry(100);
    health.register("memory", () => memory.health());
    health.register("projects", () => projects.health());
    health.register("workers", () => workers.health());
    const storage = new LocalObjectStorage(join(directory, "objects"));
    const gpu: GpuMonitor = { inspect: () => Promise.resolve([]) };
    const app = await buildApp({
      config,
      control: {
        agents: [],
        approvalGate: new ApprovalGate(ApprovalGate.generateSecret()),
        authorizer: new PermissionAuthorizer(new Map()),
        backupSources: [],
        backups: new BackupService(storage),
        compute: new Map(),
        events,
        gpu,
        memory,
        metrics: new MetricsRegistry(),
        models: new ModelCatalog(),
        plugins,
        projects,
        scheduler,
        workers
      },
      health,
      logger
    });
    try {
      const created = await within(
        "project request",
        app.inject({
          body: { name: "A1", path: join(directory, "A1") },
          method: "POST",
          url: "/api/v1/projects"
        })
      );
      expect(created.statusCode).toBe(201);
      const backup = await within(
        "backup request",
        app.inject({ method: "POST", url: "/api/v1/backups" })
      );
      expect(backup.statusCode).toBe(201);
      const dashboard = await within(
        "dashboard request",
        app.inject({ method: "GET", url: "/api/v1/dashboard" })
      );
      expect(dashboard.statusCode).toBe(200);
      expect(dashboard.json()).toMatchObject({
        health: { status: "healthy" },
        projects: [{ name: "A1" }]
      });
      const metrics = await within(
        "metrics request",
        app.inject({ method: "GET", url: "/metrics" })
      );
      expect(metrics.body).toContain("a1_http_requests_total");
    } finally {
      await within("app close", app.close());
      await within("plugin stop", plugins.stop());
      await within("scheduler stop", scheduler.stop());
      await within("worker stop", workers.stop());
      await within("project stop", projects.stop());
      await within("memory stop", memory.stop());
      await rm(directory, { force: true, recursive: true });
    }
  });
});
