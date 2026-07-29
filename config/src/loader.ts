import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse } from "yaml";
import { ZodError } from "zod";

import { a1ConfigSchema, type A1Config } from "./schema.js";

export class ConfigurationError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ConfigurationError";
  }
}

export interface LoadConfigOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly path?: string;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRecords(base: UnknownRecord, override: UnknownRecord): UnknownRecord {
  const merged: UnknownRecord = { ...base };

  for (const [key, overrideValue] of Object.entries(override)) {
    const baseValue = merged[key];
    merged[key] =
      isRecord(baseValue) && isRecord(overrideValue)
        ? mergeRecords(baseValue, overrideValue)
        : overrideValue;
  }

  return merged;
}

function definedEntries(entries: readonly (readonly [string, unknown])[]): UnknownRecord {
  return Object.fromEntries(entries.filter((entry) => entry[1] !== undefined));
}

function environmentOverrides(environment: NodeJS.ProcessEnv): UnknownRecord {
  return {
    audit: definedEntries([
      ["filePath", environment.A1_AUDIT_FILE_PATH],
      ["syncWrites", environment.A1_AUDIT_SYNC_WRITES]
    ]),
    application: definedEntries([
      ["environment", environment.A1_ENVIRONMENT],
      ["name", environment.A1_APPLICATION_NAME],
      ["version", environment.A1_APPLICATION_VERSION]
    ]),
    logging: definedEntries([["level", environment.A1_LOG_LEVEL]]),
    plugins: definedEntries([
      ["a1ApiVersion", environment.A1_PLUGIN_API_VERSION],
      [
        "grantedPermissions",
        environment.A1_PLUGIN_PERMISSIONS?.split(",")
          .map((permission) => permission.trim())
          .filter((permission) => permission.length > 0)
      ]
    ]),
    scheduler: definedEntries([
      ["claimBatchSize", environment.A1_SCHEDULER_CLAIM_BATCH_SIZE],
      ["databaseBusyTimeoutMs", environment.A1_DATABASE_BUSY_TIMEOUT_MS],
      ["databasePath", environment.A1_DATABASE_PATH],
      ["defaultMaxAttempts", environment.A1_TASK_DEFAULT_MAX_ATTEMPTS],
      ["defaultTaskTimeoutMs", environment.A1_TASK_DEFAULT_TIMEOUT_MS],
      ["leaseDurationMs", environment.A1_SCHEDULER_LEASE_DURATION_MS],
      ["maxConcurrency", environment.A1_SCHEDULER_MAX_CONCURRENCY],
      ["pollIntervalMs", environment.A1_SCHEDULER_POLL_INTERVAL_MS],
      ["retryBaseDelayMs", environment.A1_TASK_RETRY_BASE_DELAY_MS],
      ["retryJitter", environment.A1_TASK_RETRY_JITTER],
      ["retryMaxDelayMs", environment.A1_TASK_RETRY_MAX_DELAY_MS]
    ]),
    server: definedEntries([
      ["bodyLimitBytes", environment.A1_SERVER_BODY_LIMIT_BYTES],
      ["healthCheckTimeoutMs", environment.A1_HEALTH_CHECK_TIMEOUT_MS],
      ["host", environment.A1_SERVER_HOST],
      ["port", environment.A1_SERVER_PORT],
      ["requestTimeoutMs", environment.A1_REQUEST_TIMEOUT_MS],
      ["shutdownTimeoutMs", environment.A1_SHUTDOWN_TIMEOUT_MS],
      ["trustProxy", environment.A1_TRUST_PROXY]
    ])
  };
}

function deepFreeze<T>(value: T): T {
  if (isRecord(value) || Array.isArray(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }

  return value;
}

function formatValidationError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("; ");
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<A1Config> {
  const environment = options.environment ?? process.env;
  const defaultConfigPath = fileURLToPath(new URL("../default.yaml", import.meta.url));
  const configuredPath = options.path ?? environment.A1_CONFIG_PATH ?? defaultConfigPath;
  const configPath = resolve(configuredPath);

  let fileContents: string;
  try {
    fileContents = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    throw new ConfigurationError(`Unable to read A1 configuration at "${configPath}".`, {
      cause: error
    });
  }

  let fileConfiguration: unknown;
  try {
    fileConfiguration = parse(fileContents);
  } catch (error: unknown) {
    throw new ConfigurationError(`Configuration at "${configPath}" is not valid YAML.`, {
      cause: error
    });
  }

  if (!isRecord(fileConfiguration)) {
    throw new ConfigurationError(
      `Configuration at "${configPath}" must contain a YAML object at its root.`
    );
  }

  const merged = mergeRecords(fileConfiguration, environmentOverrides(environment));

  try {
    const parsed = a1ConfigSchema.parse(merged);
    const configDirectory = dirname(configPath);
    const resolveConfiguredPath = (path: string): string =>
      isAbsolute(path) ? path : resolve(configDirectory, path);

    return deepFreeze({
      ...parsed,
      audit: {
        ...parsed.audit,
        filePath: resolveConfiguredPath(parsed.audit.filePath)
      },
      memory: {
        ...parsed.memory,
        databasePath: resolveConfiguredPath(parsed.memory.databasePath)
      },
      projects: {
        ...parsed.projects,
        databasePath: resolveConfiguredPath(parsed.projects.databasePath)
      },
      scheduler: {
        ...parsed.scheduler,
        databasePath: resolveConfiguredPath(parsed.scheduler.databasePath)
      },
      security: {
        ...parsed.security,
        encryptedSecretFilePath: resolveConfiguredPath(parsed.security.encryptedSecretFilePath)
      },
      storage: {
        ...parsed.storage,
        providers: parsed.storage.providers.map((provider) =>
          provider.type === "local"
            ? { ...provider, rootPath: resolveConfiguredPath(provider.rootPath) }
            : provider
        )
      },
      workers: {
        ...parsed.workers,
        databasePath: resolveConfiguredPath(parsed.workers.databasePath)
      }
    });
  } catch (error: unknown) {
    if (error instanceof ZodError) {
      throw new ConfigurationError(
        `Configuration at "${configPath}" failed validation: ${formatValidationError(error)}`,
        { cause: error }
      );
    }

    throw error;
  }
}
