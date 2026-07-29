import { describe, expect, it, vi } from "vitest";

import { ApplicationRuntime, LifecycleError, type LifecycleComponent } from "./lifecycle.js";

function component(
  name: string,
  start: LifecycleComponent["start"] = vi.fn(() => Promise.resolve()),
  stop: LifecycleComponent["stop"] = vi.fn(() => Promise.resolve())
): LifecycleComponent {
  return { name, start, stop };
}

describe("ApplicationRuntime", () => {
  it("starts in registration order and stops in reverse order", async () => {
    const calls: string[] = [];
    const runtime = new ApplicationRuntime();
    runtime.register(
      component(
        "first",
        () => {
          calls.push("start:first");
          return Promise.resolve();
        },
        () => {
          calls.push("stop:first");
          return Promise.resolve();
        }
      )
    );
    runtime.register(
      component(
        "second",
        () => {
          calls.push("start:second");
          return Promise.resolve();
        },
        () => {
          calls.push("stop:second");
          return Promise.resolve();
        }
      )
    );

    await runtime.start();
    await runtime.stop();

    expect(calls).toEqual(["start:first", "start:second", "stop:second", "stop:first"]);
    expect(runtime.state).toBe("stopped");
  });

  it("rolls back components that started before a startup failure", async () => {
    const stopFirst = vi.fn<LifecycleComponent["stop"]>();
    const runtime = new ApplicationRuntime();
    runtime.register(component("first", vi.fn<LifecycleComponent["start"]>(), stopFirst));
    runtime.register(component("second", () => Promise.reject(new Error("startup failed"))));

    await expect(runtime.start()).rejects.toBeInstanceOf(LifecycleError);
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(runtime.state).toBe("failed");
  });
});
