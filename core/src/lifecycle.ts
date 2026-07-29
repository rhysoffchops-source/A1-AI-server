export interface LifecycleComponent {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type RuntimeState = "idle" | "starting" | "running" | "stopping" | "stopped" | "failed";

export class LifecycleError extends Error {
  public constructor(
    message: string,
    public readonly componentName: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "LifecycleError";
  }
}

export class ApplicationRuntime {
  readonly #components: LifecycleComponent[] = [];
  readonly #startedComponents: LifecycleComponent[] = [];
  #state: RuntimeState = "idle";

  public get state(): RuntimeState {
    return this.#state;
  }

  public register(component: LifecycleComponent): void {
    if (this.#state !== "idle") {
      throw new LifecycleError(
        `Cannot register component "${component.name}" after startup has begun.`,
        component.name
      );
    }

    if (this.#components.some((candidate) => candidate.name === component.name)) {
      throw new LifecycleError(
        `A component named "${component.name}" is already registered.`,
        component.name
      );
    }

    this.#components.push(component);
  }

  public async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new LifecycleError(
        `Runtime cannot start from state "${this.#state}".`,
        "application-runtime"
      );
    }

    this.#state = "starting";

    for (const component of this.#components) {
      try {
        await component.start();
        this.#startedComponents.push(component);
      } catch (error: unknown) {
        this.#state = "failed";
        const rollbackErrors = await this.#stopStartedComponents();
        const detail =
          rollbackErrors.length === 0
            ? ""
            : ` Rollback also failed for: ${rollbackErrors.join(", ")}.`;

        throw new LifecycleError(
          `Component "${component.name}" failed to start.${detail}`,
          component.name,
          { cause: error }
        );
      }
    }

    this.#state = "running";
  }

  public async stop(): Promise<void> {
    if (this.#state === "stopped" || this.#state === "idle") {
      this.#state = "stopped";
      return;
    }

    if (this.#state === "stopping") {
      return;
    }

    this.#state = "stopping";
    const failedComponents = await this.#stopStartedComponents();

    if (failedComponents.length > 0) {
      this.#state = "failed";
      throw new LifecycleError(
        `Failed to stop components: ${failedComponents.join(", ")}.`,
        failedComponents[0] ?? "application-runtime"
      );
    }

    this.#state = "stopped";
  }

  async #stopStartedComponents(): Promise<string[]> {
    const failures: string[] = [];

    while (this.#startedComponents.length > 0) {
      const component = this.#startedComponents.pop();
      if (component === undefined) {
        break;
      }

      try {
        await component.stop();
      } catch {
        failures.push(component.name);
      }
    }

    return failures;
  }
}
