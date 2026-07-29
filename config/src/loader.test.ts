import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "./loader.js";

const temporaryDirectories: string[] = [];

const VALID_CONFIGURATION = `
agents:
  definitions: []
audit:
  filePath: ../data/runtime/audit/audit.jsonl
  syncWrites: true
application:
  environment: development
  name: a1-control-plane
  version: 0.2.0
compute:
  providers: []
logging:
  level: info
memory:
  databaseBusyTimeoutMs: 5000
  databasePath: ../data/runtime/memory.sqlite
  defaultSearchLimit: 20
mcp:
  grantedPermissions: []
  servers: []
models:
  catalog: []
  providers: []
monitoring:
  gpu:
    enabled: true
plugins:
  a1ApiVersion: 1.0.0
  grantedPermissions: []
projects:
  databaseBusyTimeoutMs: 5000
  databasePath: ../data/runtime/projects.sqlite
scheduler:
  claimBatchSize: 16
  databaseBusyTimeoutMs: 5000
  databasePath: ../data/runtime/a1.sqlite
  defaultMaxAttempts: 3
  defaultTaskTimeoutMs: 300000
  leaseDurationMs: 30000
  maxConcurrency: 4
  pollIntervalMs: 250
  retryBaseDelayMs: 1000
  retryJitter: 0.2
  retryMaxDelayMs: 60000
security:
  approvalTtlSeconds: 300
  authentication:
    audience: a1-api
    enabled: false
    issuer: a1
    tokenSecret: auth.token
    tokenTtlSeconds: 3600
  encryptedSecretFilePath: ../data/runtime/secrets.enc.json
  encryptedSecretKey: secrets.master-key
  rolePermissions: {}
storage:
  backupProviderId: local
  defaultProviderId: local
  providers:
    - id: local
      rootPath: ../data/runtime/objects
      type: local
workers:
  databaseBusyTimeoutMs: 5000
  databasePath: ../data/runtime/workers.sqlite
  definitions: []
server:
  bodyLimitBytes: 1048576
  healthCheckTimeoutMs: 2000
  host: 127.0.0.1
  port: 8787
  requestTimeoutMs: 30000
  shutdownTimeoutMs: 10000
  trustProxy: false
`;

async function configurationFile(contents = VALID_CONFIGURATION): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "a1-config-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "config.yaml");
  await writeFile(path, contents, "utf8");
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(async (directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("loadConfig", () => {
  it("loads YAML and applies typed environment overrides", async () => {
    const path = await configurationFile();

    const config = await loadConfig({
      environment: {
        A1_ENVIRONMENT: "production",
        A1_LOG_LEVEL: "warn",
        A1_SERVER_PORT: "9000"
      },
      path
    });

    expect(config.application.environment).toBe("production");
    expect(config.logging.level).toBe("warn");
    expect(config.server.port).toBe(9000);
    expect(config.scheduler.databasePath).toBe(join(dirname(path), "../data/runtime/a1.sqlite"));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects unknown keys instead of silently accepting mistakes", async () => {
    const path = await configurationFile(`${VALID_CONFIGURATION}\nunknown: true\n`);

    await expect(loadConfig({ environment: {}, path })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it("rejects duplicate provider identifiers", async () => {
    const configuration = VALID_CONFIGURATION.replace(
      "providers: []\nmonitoring:",
      `providers:
    - baseUrl: https://example.com/v1
      enabled: true
      headers: {}
      id: duplicate
      timeoutMs: 1000
      type: openai-compatible
    - baseUrl: https://example.net/v1
      enabled: true
      headers: {}
      id: duplicate
      timeoutMs: 1000
      type: openai-compatible
monitoring:`
    );
    const path = await configurationFile(configuration);
    await expect(loadConfig({ environment: {}, path })).rejects.toThrow(
      "Model provider IDs must be unique"
    );
  });

  it("accepts provider-specific secret header handles", async () => {
    const configuration = VALID_CONFIGURATION.replace(
      "providers: []\nmonitoring:",
      `providers:
    - baseUrl: https://example.com/v1
      enabled: true
      headerSecrets:
        Modal-Key: modal.proxy-token-id
        Modal-Secret: modal.proxy-token-secret
      headers: {}
      id: modal
      timeoutMs: 1000
      type: openai-compatible
monitoring:`
    );
    const path = await configurationFile(configuration);
    const config = await loadConfig({ environment: {}, path });

    expect(config.models.providers[0]?.headerSecrets).toEqual({
      "Modal-Key": "modal.proxy-token-id",
      "Modal-Secret": "modal.proxy-token-secret"
    });
  });

  it("fails clearly when the configuration file is missing", async () => {
    await expect(
      loadConfig({
        environment: {},
        path: join(tmpdir(), "a1-file-that-does-not-exist.yaml")
      })
    ).rejects.toThrow("Unable to read A1 configuration");
  });
});
