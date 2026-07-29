import type { EventPublisher, HealthCheckResult, LifecycleComponent, Logger } from "@a1/core";
import type { AuditRecorder } from "@a1/security";
import semver from "semver";

import { validatePluginManifest, type PluginManifest } from "./manifest.js";

export interface PluginContext {
  readonly logger: Logger;
  readonly pluginId: string;
  readonly signal: AbortSignal;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginContext): Promise<void>;
  deactivate(): Promise<void>;
}

export type PluginStatus = "active" | "failed" | "inactive" | "registered";

export interface PluginSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: PluginStatus;
  readonly version: string;
}

export interface PluginEventMap {
  "plugin.activated": {
    readonly pluginId: string;
    readonly version: string;
  };
  "plugin.deactivated": {
    readonly pluginId: string;
    readonly version: string;
  };
  "plugin.failed": {
    readonly phase: "activate" | "deactivate";
    readonly pluginId: string;
    readonly version: string;
  };
}

interface RegisteredPlugin {
  readonly plugin: Plugin;
  readonly manifest: PluginManifest;
  abortController: AbortController | undefined;
  status: PluginStatus;
}

export interface PluginManagerOptions {
  readonly a1ApiVersion: string;
  readonly audit: AuditRecorder;
  readonly events: EventPublisher<PluginEventMap>;
  readonly grantedPermissions: ReadonlySet<string>;
  readonly logger: Logger;
}

export class PluginLifecycleError extends Error {
  public constructor(
    message: string,
    public readonly pluginId: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "PluginLifecycleError";
  }
}

export class PluginManager implements LifecycleComponent {
  public readonly name = "plugin-manager";
  readonly #plugins = new Map<string, RegisteredPlugin>();
  readonly #startedPluginIds: string[] = [];
  #state: "failed" | "idle" | "running" | "starting" | "stopped" | "stopping" = "idle";

  public constructor(private readonly options: PluginManagerOptions) {
    if (semver.valid(options.a1ApiVersion) === null) {
      throw new TypeError(
        `A1 API version "${options.a1ApiVersion}" is not valid semantic version.`
      );
    }
  }

  public register(plugin: Plugin): void {
    if (this.#state !== "idle") {
      throw new PluginLifecycleError(
        "Plugins can only be registered before the plugin manager starts.",
        plugin.manifest.id
      );
    }

    const manifest = validatePluginManifest(plugin.manifest);
    if (semver.valid(manifest.version) === null) {
      throw new PluginLifecycleError(
        `Plugin version "${manifest.version}" is not valid semantic version.`,
        manifest.id
      );
    }
    if (semver.validRange(manifest.a1ApiVersion) === null) {
      throw new PluginLifecycleError(
        `Plugin A1 API range "${manifest.a1ApiVersion}" is invalid.`,
        manifest.id
      );
    }
    if (this.#plugins.has(manifest.id)) {
      throw new PluginLifecycleError(`Plugin "${manifest.id}" is already registered.`, manifest.id);
    }

    this.#plugins.set(manifest.id, {
      abortController: undefined,
      manifest,
      plugin,
      status: "registered"
    });
  }

  public list(): readonly PluginSnapshot[] {
    return [...this.#plugins.values()]
      .map(({ manifest, status }) => ({
        id: manifest.id,
        name: manifest.name,
        status,
        version: manifest.version
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  public async start(): Promise<void> {
    if (this.#state !== "idle") {
      throw new PluginLifecycleError(
        `Plugin manager cannot start from state "${this.#state}".`,
        "plugin-manager"
      );
    }

    this.#state = "starting";
    let activationOrder: readonly RegisteredPlugin[];
    try {
      activationOrder = this.#resolveActivationOrder();
      await this.#validatePermissions(activationOrder);
    } catch (error: unknown) {
      this.#state = "failed";
      throw error;
    }

    for (const registered of activationOrder) {
      const { plugin } = registered;
      const pluginId = registered.manifest.id;
      const abortController = new AbortController();
      registered.abortController = abortController;
      let activationCompleted = false;

      try {
        await plugin.activate({
          logger: this.options.logger.child({ pluginId }),
          pluginId,
          signal: abortController.signal
        });
        activationCompleted = true;
        registered.status = "active";
        this.#startedPluginIds.push(pluginId);
        await this.options.audit.record({
          action: "plugin.activate",
          actor: { id: "a1-plugin-manager", kind: "system" },
          metadata: { version: registered.manifest.version },
          outcome: "success",
          severity: "info",
          target: { id: pluginId, type: "plugin" }
        });
        await this.#publish("plugin.activated", registered);
      } catch (error: unknown) {
        abortController.abort();
        if (!activationCompleted) {
          try {
            await plugin.deactivate();
          } catch (cleanupError: unknown) {
            await this.#recordFailure("plugin.deactivate", registered, cleanupError);
            this.options.logger.error(
              { err: cleanupError, pluginId },
              "Failed to clean up a partially activated plugin"
            );
          } finally {
            registered.abortController = undefined;
          }
        }
        await this.#recordFailure("plugin.activate", registered, error);
        await this.#publish("plugin.failed", registered, "activate");
        await this.#rollbackStartedPlugins();
        registered.status = "failed";
        this.#state = "failed";
        throw new PluginLifecycleError(`Plugin "${pluginId}" failed to activate.`, pluginId, {
          cause: error
        });
      }
    }

    this.#state = "running";
  }

  public async stop(): Promise<void> {
    if (this.#state === "idle" || this.#state === "stopped") {
      this.#state = "stopped";
      return;
    }
    if (this.#state === "stopping") {
      return;
    }

    this.#state = "stopping";
    const failures = await this.#deactivateStartedPlugins();
    this.#state = failures.length === 0 ? "stopped" : "failed";

    if (failures.length > 0) {
      throw new PluginLifecycleError(
        `Failed to deactivate plugins: ${failures.join(", ")}.`,
        failures[0] ?? "plugin-manager"
      );
    }
  }

  public health(): HealthCheckResult {
    if (this.#state !== "running") {
      return {
        message: `Plugin manager is ${this.#state}.`,
        status: "unhealthy"
      };
    }
    if ([...this.#plugins.values()].some((plugin) => plugin.status === "failed")) {
      return {
        message: "One or more plugins failed.",
        status: "degraded"
      };
    }
    return { status: "healthy" };
  }

  #resolveActivationOrder(): readonly RegisteredPlugin[] {
    const ordered: RegisteredPlugin[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (pluginId: string): void => {
      if (visited.has(pluginId)) {
        return;
      }
      if (visiting.has(pluginId)) {
        throw new PluginLifecycleError(`Plugin dependency cycle includes "${pluginId}".`, pluginId);
      }

      const registered = this.#plugins.get(pluginId);
      if (registered === undefined) {
        throw new PluginLifecycleError(
          `Plugin dependency "${pluginId}" is not registered.`,
          pluginId
        );
      }

      const { manifest } = registered;
      if (!semver.satisfies(this.options.a1ApiVersion, manifest.a1ApiVersion)) {
        throw new PluginLifecycleError(
          `Plugin "${pluginId}" does not support A1 API ${this.options.a1ApiVersion}.`,
          pluginId
        );
      }

      visiting.add(pluginId);
      for (const [dependencyId, requiredRange] of Object.entries(manifest.dependencies)) {
        const dependency = this.#plugins.get(dependencyId);
        if (dependency === undefined) {
          throw new PluginLifecycleError(
            `Plugin "${pluginId}" requires missing plugin "${dependencyId}".`,
            pluginId
          );
        }
        if (!semver.satisfies(dependency.manifest.version, requiredRange)) {
          throw new PluginLifecycleError(
            `Plugin "${pluginId}" requires "${dependencyId}" ${requiredRange}.`,
            pluginId
          );
        }
        visit(dependencyId);
      }
      visiting.delete(pluginId);
      visited.add(pluginId);
      ordered.push(registered);
    };

    for (const pluginId of [...this.#plugins.keys()].sort()) {
      visit(pluginId);
    }

    return ordered;
  }

  async #validatePermissions(plugins: readonly RegisteredPlugin[]): Promise<void> {
    for (const registered of plugins) {
      const missing = registered.manifest.permissions.filter(
        (permission) => !this.options.grantedPermissions.has(permission)
      );
      if (missing.length === 0) {
        continue;
      }

      const pluginId = registered.manifest.id;
      await this.options.audit.record({
        action: "plugin.activate",
        actor: { id: "a1-plugin-manager", kind: "system" },
        metadata: { missingPermissions: missing },
        outcome: "denied",
        reason: "Required permissions were not granted.",
        severity: "warning",
        target: { id: pluginId, type: "plugin" }
      });
      throw new PluginLifecycleError(
        `Plugin "${pluginId}" is missing permissions: ${missing.join(", ")}.`,
        pluginId
      );
    }
  }

  async #rollbackStartedPlugins(): Promise<void> {
    const failures = await this.#deactivateStartedPlugins();
    if (failures.length > 0) {
      this.options.logger.error({ plugins: failures }, "Plugin activation rollback was incomplete");
    }
  }

  async #deactivateStartedPlugins(): Promise<string[]> {
    const failures: string[] = [];

    while (this.#startedPluginIds.length > 0) {
      const pluginId = this.#startedPluginIds.pop();
      if (pluginId === undefined) {
        break;
      }
      const registered = this.#plugins.get(pluginId);
      if (registered === undefined) {
        continue;
      }

      registered.abortController?.abort();
      try {
        await registered.plugin.deactivate();
        await this.options.audit.record({
          action: "plugin.deactivate",
          actor: { id: "a1-plugin-manager", kind: "system" },
          metadata: { version: registered.manifest.version },
          outcome: "success",
          severity: "info",
          target: { id: pluginId, type: "plugin" }
        });
        registered.status = "inactive";
        await this.#publish("plugin.deactivated", registered);
      } catch (error: unknown) {
        registered.status = "failed";
        failures.push(pluginId);
        await this.#recordFailure("plugin.deactivate", registered, error);
        await this.#publish("plugin.failed", registered, "deactivate");
      } finally {
        registered.abortController = undefined;
      }
    }

    return failures;
  }

  async #recordFailure(
    action: "plugin.activate" | "plugin.deactivate",
    registered: RegisteredPlugin,
    error: unknown
  ): Promise<void> {
    const reason = error instanceof Error ? error.message : "Plugin failed with a non-error value.";
    try {
      await this.options.audit.record({
        action,
        actor: { id: "a1-plugin-manager", kind: "system" },
        metadata: { version: registered.manifest.version },
        outcome: "failure",
        reason,
        severity: "critical",
        target: { id: registered.manifest.id, type: "plugin" }
      });
    } catch (auditError: unknown) {
      this.options.logger.error({ err: auditError }, "Failed to record plugin audit event");
    }
  }

  async #publish(
    type: keyof PluginEventMap,
    registered: RegisteredPlugin,
    phase?: "activate" | "deactivate"
  ): Promise<void> {
    try {
      switch (type) {
        case "plugin.activated":
          await this.options.events.publish({
            payload: {
              pluginId: registered.manifest.id,
              version: registered.manifest.version
            },
            source: this.name,
            type: "plugin.activated"
          });
          break;
        case "plugin.deactivated":
          await this.options.events.publish({
            payload: {
              pluginId: registered.manifest.id,
              version: registered.manifest.version
            },
            source: this.name,
            type: "plugin.deactivated"
          });
          break;
        case "plugin.failed":
          await this.options.events.publish({
            payload: {
              phase: phase ?? "activate",
              pluginId: registered.manifest.id,
              version: registered.manifest.version
            },
            source: this.name,
            type: "plugin.failed"
          });
          break;
      }
    } catch (error: unknown) {
      this.options.logger.error(
        { err: error, pluginId: registered.manifest.id, type },
        "Plugin lifecycle event dispatch failed"
      );
    }
  }
}
