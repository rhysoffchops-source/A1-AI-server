import { describe, expect, it } from "vitest";

import type { A1Config } from "@a1/config";
import { createLogger, HealthRegistry } from "@a1/core";
import { HmacTokenService } from "@a1/security";

import { buildApp } from "./app.js";

const config: A1Config = {
  agents: {
    definitions: []
  },
  audit: {
    filePath: "/tmp/a1-api-test-audit.jsonl",
    syncWrites: false
  },
  application: {
    environment: "test",
    name: "a1-api-test",
    version: "0.1.0"
  },
  compute: {
    providers: []
  },
  logging: {
    level: "fatal"
  },
  memory: {
    databaseBusyTimeoutMs: 1_000,
    databasePath: "/tmp/a1-api-test-memory.sqlite",
    defaultSearchLimit: 20
  },
  mcp: {
    grantedPermissions: [],
    servers: []
  },
  models: {
    catalog: [],
    providers: []
  },
  monitoring: {
    gpu: {
      enabled: true
    }
  },
  plugins: {
    a1ApiVersion: "1.0.0",
    grantedPermissions: []
  },
  projects: {
    databaseBusyTimeoutMs: 1_000,
    databasePath: "/tmp/a1-api-test-projects.sqlite"
  },
  scheduler: {
    claimBatchSize: 4,
    databaseBusyTimeoutMs: 1_000,
    databasePath: "/tmp/a1-api-test.sqlite",
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
    encryptedSecretFilePath: "/tmp/a1-api-test-secrets.enc.json",
    encryptedSecretKey: "secrets.master-key",
    rolePermissions: {}
  },
  storage: {
    backupProviderId: "local",
    defaultProviderId: "local",
    providers: [{ id: "local", rootPath: "/tmp/a1-api-test-objects", type: "local" }]
  },
  workers: {
    databaseBusyTimeoutMs: 1_000,
    databasePath: "/tmp/a1-api-test-workers.sqlite",
    definitions: []
  },
  server: {
    bodyLimitBytes: 1_048_576,
    healthCheckTimeoutMs: 100,
    host: "127.0.0.1",
    port: 8787,
    requestTimeoutMs: 1_000,
    shutdownTimeoutMs: 1_000,
    trustProxy: false
  }
};

const logger = createLogger({
  environment: config.application.environment,
  level: config.logging.level,
  serviceName: config.application.name,
  version: config.application.version
});

describe("A1 API health endpoints", () => {
  it("reports process liveness", async () => {
    const app = await buildApp({
      config,
      health: new HealthRegistry(config.server.healthCheckTimeoutMs),
      logger
    });

    const response = await app.inject({
      method: "GET",
      url: "/health/live"
    });
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "healthy" });
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns 503 when a required readiness check fails", async () => {
    const health = new HealthRegistry(config.server.healthCheckTimeoutMs);
    health.register("required-service", () => ({ status: "unhealthy" }));
    const app = await buildApp({ config, health, logger });

    const response = await app.inject({
      method: "GET",
      url: "/health/ready"
    });
    await app.close();

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: "unhealthy"
    });
  });

  it("does not expose internal errors to clients", async () => {
    const app = await buildApp({
      config,
      health: new HealthRegistry(config.server.healthCheckTimeoutMs),
      logger
    });
    app.get("/test/error", () => {
      throw new Error("sensitive internal detail");
    });

    const response = await app.inject({
      method: "GET",
      url: "/test/error"
    });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive internal detail");
  });

  it("protects non-health routes when authentication is enabled", async () => {
    const tokenService = new HmacTokenService({
      audience: "a1-api",
      issuer: "a1",
      secret: new TextEncoder().encode("01234567890123456789012345678901"),
      ttlSeconds: 60
    });
    const app = await buildApp({
      config,
      health: new HealthRegistry(config.server.healthCheckTimeoutMs),
      logger,
      tokenService
    });
    app.get("/protected", (request) => ({ principalId: request.a1Principal?.id }));
    const dashboardShell = await app.inject({ method: "GET", url: "/" });
    const denied = await app.inject({ method: "GET", url: "/protected" });
    const token = tokenService.issue({
      id: "user-1",
      permissions: new Set(),
      roles: new Set(["operator"])
    });
    const allowed = await app.inject({
      headers: { authorization: `Bearer ${token}` },
      method: "GET",
      url: "/protected"
    });
    await app.close();
    expect(dashboardShell.statusCode).toBe(200);
    expect(denied.statusCode).toBe(401);
    expect(allowed.json()).toEqual({ principalId: "user-1" });
  });
});
