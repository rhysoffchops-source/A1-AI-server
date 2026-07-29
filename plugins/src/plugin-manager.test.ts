import { createLogger, InMemoryEventBus } from "@a1/core";
import type { AuditEnvelope, AuditInput, AuditRecorder } from "@a1/security";
import { describe, expect, it, vi } from "vitest";

import type { Plugin, PluginManifest } from "./index.js";
import { PluginLifecycleError, PluginManager, type PluginEventMap } from "./plugin-manager.js";

function manifest(
  id: string,
  options: {
    readonly dependencies?: Readonly<Record<string, string>>;
    readonly permissions?: readonly string[];
  } = {}
): PluginManifest {
  return {
    a1ApiVersion: "^1.0.0",
    dependencies: options.dependencies ?? {},
    description: `Test plugin ${id}`,
    id,
    name: id,
    permissions: [...(options.permissions ?? [])],
    version: "1.0.0"
  };
}

function plugin(
  pluginManifest: PluginManifest,
  activate: Plugin["activate"] = vi.fn(() => Promise.resolve()),
  deactivate: Plugin["deactivate"] = vi.fn(() => Promise.resolve())
): Plugin {
  return {
    activate,
    deactivate,
    manifest: pluginManifest
  };
}

interface TestAuditRecorder {
  readonly audit: AuditRecorder;
  readonly record: ReturnType<typeof vi.fn<AuditRecorder["record"]>>;
}

function auditRecorder(): TestAuditRecorder {
  const record = vi.fn<AuditRecorder["record"]>((input: AuditInput) =>
    Promise.resolve({
      ...input,
      id: "audit-id",
      metadata: input.metadata ?? {},
      occurredAt: new Date().toISOString()
    } as AuditEnvelope)
  );
  return {
    audit: { record },
    record
  };
}

function manager(audit: AuditRecorder, permissions: readonly string[] = []): PluginManager {
  return new PluginManager({
    a1ApiVersion: "1.0.0",
    audit,
    events: new InMemoryEventBus<PluginEventMap>(),
    grantedPermissions: new Set(permissions),
    logger: createLogger({
      environment: "test",
      level: "fatal",
      serviceName: "plugin-test",
      version: "0.2.0"
    })
  });
}

describe("PluginManager", () => {
  it("activates dependencies first and deactivates in reverse order", async () => {
    const calls: string[] = [];
    const first = plugin(
      manifest("com.a1.first"),
      () => {
        calls.push("activate:first");
        return Promise.resolve();
      },
      () => {
        calls.push("deactivate:first");
        return Promise.resolve();
      }
    );
    const second = plugin(
      manifest("com.a1.second", { dependencies: { "com.a1.first": "^1.0.0" } }),
      () => {
        calls.push("activate:second");
        return Promise.resolve();
      },
      () => {
        calls.push("deactivate:second");
        return Promise.resolve();
      }
    );
    const pluginManager = manager(auditRecorder().audit);
    pluginManager.register(second);
    pluginManager.register(first);

    await pluginManager.start();
    await pluginManager.stop();

    expect(calls).toEqual([
      "activate:first",
      "activate:second",
      "deactivate:second",
      "deactivate:first"
    ]);
  });

  it("denies activation when a declared permission was not granted", async () => {
    const audit = auditRecorder();
    const pluginManager = manager(audit.audit);
    pluginManager.register(
      plugin(manifest("com.a1.restricted", { permissions: ["filesystem.read"] }))
    );

    await expect(pluginManager.start()).rejects.toBeInstanceOf(PluginLifecycleError);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "plugin.activate",
        outcome: "denied"
      })
    );
  });

  it("rolls back active plugins when a later activation fails", async () => {
    const deactivateFirst = vi.fn(() => Promise.resolve());
    const deactivateSecond = vi.fn(() => Promise.resolve());
    const pluginManager = manager(auditRecorder().audit);
    pluginManager.register(plugin(manifest("com.a1.first"), undefined, deactivateFirst));
    pluginManager.register(
      plugin(
        manifest("com.a1.second", { dependencies: { "com.a1.first": "^1.0.0" } }),
        () => Promise.reject(new Error("activation failed")),
        deactivateSecond
      )
    );

    await expect(pluginManager.start()).rejects.toBeInstanceOf(PluginLifecycleError);
    expect(deactivateFirst).toHaveBeenCalledOnce();
    expect(deactivateSecond).toHaveBeenCalledOnce();
  });
});
