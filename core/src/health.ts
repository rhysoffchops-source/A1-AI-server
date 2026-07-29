export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface HealthCheckResult {
  readonly status: HealthStatus;
  readonly message?: string;
}

export type HealthCheck = (signal: AbortSignal) => HealthCheckResult | Promise<HealthCheckResult>;

export interface HealthCheckSnapshot extends HealthCheckResult {
  readonly durationMs: number;
  readonly name: string;
  readonly required: boolean;
}

export interface HealthSnapshot {
  readonly checks: readonly HealthCheckSnapshot[];
  readonly status: HealthStatus;
  readonly timestamp: string;
}

interface RegisteredHealthCheck {
  readonly check: HealthCheck;
  readonly required: boolean;
}

class HealthCheckTimeoutError extends Error {
  public constructor(name: string, timeoutMs: number) {
    super(`Health check "${name}" exceeded ${String(timeoutMs)} ms.`);
    this.name = "HealthCheckTimeoutError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Health check failed with a non-error value.";
}

export class HealthRegistry {
  readonly #checks = new Map<string, RegisteredHealthCheck>();

  public constructor(private readonly timeoutMs: number) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Health check timeout must be a positive integer.");
    }
  }

  public register(
    name: string,
    check: HealthCheck,
    options: { readonly required?: boolean } = {}
  ): () => void {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      throw new TypeError("Health check name cannot be empty.");
    }

    if (this.#checks.has(normalizedName)) {
      throw new Error(`Health check "${normalizedName}" is already registered.`);
    }

    this.#checks.set(normalizedName, {
      check,
      required: options.required ?? true
    });

    return (): void => {
      this.#checks.delete(normalizedName);
    };
  }

  public async inspect(): Promise<HealthSnapshot> {
    const checks = await Promise.all(
      [...this.#checks.entries()].map(async ([name, registration]) =>
        this.#execute(name, registration)
      )
    );

    let status: HealthStatus = "healthy";
    if (checks.some((check) => check.required && check.status === "unhealthy")) {
      status = "unhealthy";
    } else if (checks.some((check) => check.status !== "healthy")) {
      status = "degraded";
    }

    return {
      checks,
      status,
      timestamp: new Date().toISOString()
    };
  }

  async #execute(name: string, registration: RegisteredHealthCheck): Promise<HealthCheckSnapshot> {
    const startedAt = performance.now();
    const abortController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          abortController.abort();
          reject(new HealthCheckTimeoutError(name, this.timeoutMs));
        }, this.timeoutMs);
        timeout.unref();
      });

      const result = await Promise.race([
        Promise.resolve(registration.check(abortController.signal)),
        timeoutPromise
      ]);

      return {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        ...(result.message === undefined ? {} : { message: result.message }),
        name,
        required: registration.required,
        status: result.status
      };
    } catch (error: unknown) {
      return {
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        message: errorMessage(error),
        name,
        required: registration.required,
        status: "unhealthy"
      };
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  }
}
