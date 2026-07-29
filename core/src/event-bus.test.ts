import { describe, expect, it, vi } from "vitest";

import { EventDispatchError, InMemoryEventBus } from "./event-bus.js";

interface TestEvents {
  "project.created": {
    readonly projectId: string;
  };
  "task.completed": {
    readonly taskId: string;
  };
}

describe("InMemoryEventBus", () => {
  it("delivers events in publication order", async () => {
    const bus = new InMemoryEventBus<TestEvents>();
    const delivered: string[] = [];
    bus.subscribe("project.created", (event) => {
      delivered.push(event.payload.projectId);
    });

    await Promise.all([
      bus.publish({
        payload: { projectId: "first" },
        source: "test",
        type: "project.created"
      }),
      bus.publish({
        payload: { projectId: "second" },
        source: "test",
        type: "project.created"
      })
    ]);

    expect(delivered).toEqual(["first", "second"]);
  });

  it("continues dispatching after a subscriber fails and reports all failures", async () => {
    const bus = new InMemoryEventBus<TestEvents>();
    const successfulHandler = vi.fn();
    bus.subscribe("task.completed", () => {
      throw new Error("subscriber failed");
    });
    bus.subscribe("task.completed", successfulHandler);

    await expect(
      bus.publish({
        payload: { taskId: "task-1" },
        source: "test",
        type: "task.completed"
      })
    ).rejects.toBeInstanceOf(EventDispatchError);
    expect(successfulHandler).toHaveBeenCalledOnce();
  });

  it("removes a subscriber through its unsubscribe function", async () => {
    const bus = new InMemoryEventBus<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = bus.subscribe("project.created", handler);
    unsubscribe();

    await bus.publish({
      payload: { projectId: "project-1" },
      source: "test",
      type: "project.created"
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("isolates published payloads from mutation", async () => {
    const bus = new InMemoryEventBus<TestEvents>();
    const payload = { projectId: "project-1" };
    const event = await bus.publish({
      payload,
      source: "test",
      type: "project.created"
    });
    payload.projectId = "changed";

    expect(event.payload.projectId).toBe("project-1");
    expect(Object.isFrozen(event.payload)).toBe(true);
  });
});
