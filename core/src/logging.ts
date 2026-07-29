import pino, { type Logger, type LoggerOptions } from "pino";

export type A1LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export interface CreateLoggerOptions {
  readonly environment: string;
  readonly level: A1LogLevel;
  readonly serviceName: string;
  readonly version: string;
}

const REDACTED_PATHS = [
  "authorization",
  "cookie",
  "headers.authorization",
  "headers.cookie",
  "password",
  "req.headers.authorization",
  "req.headers.cookie",
  "secret",
  "token"
];

export function createLogger(options: CreateLoggerOptions): Logger {
  const loggerOptions: LoggerOptions = {
    base: {
      environment: options.environment,
      service: options.serviceName,
      version: options.version
    },
    level: options.level,
    messageKey: "message",
    redact: {
      censor: "[REDACTED]",
      paths: REDACTED_PATHS
    },
    serializers: {
      error: pino.stdSerializers.err,
      err: pino.stdSerializers.err,
      request: pino.stdSerializers.req,
      response: pino.stdSerializers.res
    },
    timestamp: pino.stdTimeFunctions.isoTime
  };

  return pino(loggerOptions);
}

export type { Logger };
