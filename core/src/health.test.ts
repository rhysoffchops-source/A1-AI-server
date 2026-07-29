import { describe, expect, it } from "vitest";

import { HealthRegistry } from "./health.js";

describe("HealthRegistry", () => {
  it("marks a failed required check as unhealthy", async () => {
    const registry = new HealthRegistry(100);
    registry.register("database", () => {
      throw new Error("connection unavailable");
    });

    const snapshot = await registry.inspect();

    expect(snapshot.status).toBe("unhealthy");
    expect(snapshot.checks).toEqual([
      expect.objectContaining({
        message: "connection unavailable",
        name: "database",
        required: true,
        status: "unhealthy"
      })
    ]);
  });

  it("enforces the configured timeout even when a check ignores cancellation", async () => {
    const registry = new HealthRegistry(10);
    registry.register("stalled-service", () => new Promise(() => undefined));

    const snapshot = await registry.inspect();

    expect(snapshot.status).toBe("unhealthy");
    expect(snapshot.checks[0]).toEqual(
      expect.objectContaining({
        name: "stalled-service",
        status: "unhealthy"
      })
    );
  });

  it("treats an optional failure as degraded", async () => {
    const registry = new HealthRegistry(100);
    registry.register("optional-cache", () => ({ status: "unhealthy" }), {
      required: false
    });

    await expect(registry.inspect()).resolves.toMatchObject({
      status: "degraded"
    });
  });
});
