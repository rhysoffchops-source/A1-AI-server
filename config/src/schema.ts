import { z } from "zod";

const portSchema = z.coerce.number().int().min(1).max(65_535);
const positiveIntegerSchema = z.coerce.number().int().positive();
const booleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  if (value.toLowerCase() === "true") {
    return true;
  }

  if (value.toLowerCase() === "false") {
    return false;
  }

  return value;
}, z.boolean());

export const a1ConfigSchema = z
  .object({
    agents: z
      .object({
        definitions: z
          .array(
            z
              .object({
                id: z.string().trim().min(1),
                locationPreference: z.enum(["any", "cloud", "local"]),
                maxSteps: positiveIntegerSchema,
                modelCapabilities: z.array(
                  z.enum(["coding", "embedding", "fast", "long-context", "reasoning", "vision"])
                ),
                name: z.string().trim().min(1),
                permissions: z.array(z.string().trim().min(1)),
                systemPrompt: z.string().trim().min(1)
              })
              .strict()
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Agent IDs must be unique."
          )
      })
      .strict(),
    audit: z
      .object({
        filePath: z.string().trim().min(1),
        syncWrites: booleanSchema
      })
      .strict(),
    application: z
      .object({
        environment: z.enum(["development", "test", "production"]),
        name: z.string().trim().min(1).max(100),
        version: z.string().trim().min(1).max(100)
      })
      .strict(),
    compute: z
      .object({
        providers: z
          .array(
            z
              .object({
                apiKeySecret: z.string().trim().min(1),
                baseUrl: z.url().optional(),
                enabled: booleanSchema,
                id: z.string().trim().min(1),
                timeoutMs: positiveIntegerSchema,
                type: z.literal("vast-ai")
              })
              .strict()
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Compute provider IDs must be unique."
          )
      })
      .strict(),
    logging: z
      .object({
        level: z.enum(["trace", "debug", "info", "warn", "error", "fatal"])
      })
      .strict(),
    memory: z
      .object({
        databaseBusyTimeoutMs: positiveIntegerSchema,
        databasePath: z.string().trim().min(1),
        defaultSearchLimit: positiveIntegerSchema
      })
      .strict(),
    mcp: z
      .object({
        grantedPermissions: z.array(z.string().trim().min(1)),
        servers: z.array(
          z.discriminatedUnion("transport", [
            z
              .object({
                args: z.array(z.string()),
                command: z.string().trim().min(1),
                enabled: booleanSchema,
                env: z.record(z.string(), z.string()),
                id: z.string().trim().min(1),
                permissions: z.array(z.string().trim().min(1)),
                timeoutMs: positiveIntegerSchema,
                transport: z.literal("stdio")
              })
              .strict(),
            z
              .object({
                enabled: booleanSchema,
                headers: z.record(z.string(), z.string()),
                id: z.string().trim().min(1),
                permissions: z.array(z.string().trim().min(1)),
                timeoutMs: positiveIntegerSchema,
                transport: z.literal("http"),
                url: z.url()
              })
              .strict()
          ])
        )
      })
      .strict(),
    models: z
      .object({
        catalog: z
          .array(
            z
              .object({
                capabilities: z.array(
                  z.enum(["coding", "embedding", "fast", "long-context", "reasoning", "vision"])
                ),
                contextWindow: positiveIntegerSchema,
                enabled: booleanSchema,
                id: z.string().trim().min(1),
                location: z.enum(["cloud", "local"]),
                maxOutputTokens: positiveIntegerSchema,
                priority: z.coerce.number().int(),
                providerId: z.string().trim().min(1)
              })
              .strict()
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Model IDs must be unique."
          ),
        providers: z
          .array(
            z
              .object({
                apiKeySecret: z.string().trim().min(1).optional(),
                baseUrl: z.url(),
                enabled: booleanSchema,
                headers: z.record(z.string(), z.string()).default({}),
                headerSecrets: z
                  .record(z.string().trim().min(1), z.string().trim().min(1))
                  .default({}),
                id: z.string().trim().min(1),
                timeoutMs: positiveIntegerSchema,
                type: z.enum(["anthropic", "gemini", "openai-compatible"])
              })
              .strict()
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Model provider IDs must be unique."
          )
      })
      .strict(),
    monitoring: z
      .object({
        gpu: z
          .object({
            enabled: booleanSchema
          })
          .strict()
      })
      .strict(),
    plugins: z
      .object({
        a1ApiVersion: z.string().trim().min(1),
        grantedPermissions: z
          .array(z.string().trim().min(1))
          .refine(
            (permissions) => new Set(permissions).size === permissions.length,
            "Plugin permissions must be unique."
          )
      })
      .strict(),
    projects: z
      .object({
        databaseBusyTimeoutMs: positiveIntegerSchema,
        databasePath: z.string().trim().min(1)
      })
      .strict(),
    scheduler: z
      .object({
        claimBatchSize: positiveIntegerSchema,
        databaseBusyTimeoutMs: positiveIntegerSchema,
        databasePath: z.string().trim().min(1),
        defaultMaxAttempts: positiveIntegerSchema,
        defaultTaskTimeoutMs: positiveIntegerSchema,
        leaseDurationMs: positiveIntegerSchema,
        maxConcurrency: positiveIntegerSchema,
        pollIntervalMs: positiveIntegerSchema,
        retryBaseDelayMs: positiveIntegerSchema,
        retryJitter: z.coerce.number().min(0).max(1),
        retryMaxDelayMs: positiveIntegerSchema
      })
      .strict(),
    security: z
      .object({
        approvalTtlSeconds: positiveIntegerSchema,
        authentication: z
          .object({
            audience: z.string().trim().min(1),
            enabled: booleanSchema,
            issuer: z.string().trim().min(1),
            tokenSecret: z.string().trim().min(1),
            tokenTtlSeconds: positiveIntegerSchema
          })
          .strict(),
        encryptedSecretFilePath: z.string().trim().min(1),
        encryptedSecretKey: z.string().trim().min(1),
        rolePermissions: z.record(z.string(), z.array(z.string().trim().min(1)))
      })
      .strict(),
    storage: z
      .object({
        backupProviderId: z.string().trim().min(1),
        defaultProviderId: z.string().trim().min(1),
        providers: z
          .array(
            z.discriminatedUnion("type", [
              z
                .object({
                  id: z.string().trim().min(1),
                  rootPath: z.string().trim().min(1),
                  type: z.literal("local")
                })
                .strict(),
              z
                .object({
                  accessKeySecret: z.string().trim().min(1).optional(),
                  bucket: z.string().trim().min(1),
                  endpoint: z.url().optional(),
                  forcePathStyle: booleanSchema.default(false),
                  id: z.string().trim().min(1),
                  region: z.string().trim().min(1),
                  secretKeySecret: z.string().trim().min(1).optional(),
                  type: z.literal("s3")
                })
                .strict()
            ])
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Storage provider IDs must be unique."
          )
      })
      .strict(),
    workers: z
      .object({
        databaseBusyTimeoutMs: positiveIntegerSchema,
        databasePath: z.string().trim().min(1),
        definitions: z
          .array(
            z
              .object({
                allowedRoots: z.array(z.string().trim().min(1)),
                id: z.string().trim().min(1),
                name: z.string().trim().min(1),
                platform: z.enum(["linux", "macos"]),
                tokenSecret: z.string().trim().min(1)
              })
              .strict()
          )
          .refine(
            (items) => new Set(items.map((item) => item.id)).size === items.length,
            "Worker IDs must be unique."
          )
      })
      .strict(),
    server: z
      .object({
        bodyLimitBytes: positiveIntegerSchema,
        healthCheckTimeoutMs: positiveIntegerSchema,
        host: z.string().trim().min(1),
        port: portSchema,
        requestTimeoutMs: positiveIntegerSchema,
        shutdownTimeoutMs: positiveIntegerSchema,
        trustProxy: booleanSchema
      })
      .strict()
  })
  .strict();

export type A1Config = Readonly<z.infer<typeof a1ConfigSchema>>;
