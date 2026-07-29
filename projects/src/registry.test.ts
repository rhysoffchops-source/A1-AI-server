import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ProjectRegistry } from "./registry.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("ProjectRegistry", () => {
  it("persists projects and status across restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-projects-"));
    directories.push(directory);
    const options = { busyTimeoutMs: 1_000, filePath: join(directory, "projects.sqlite") };
    const first = new ProjectRegistry(options);
    await first.start();
    const created = await first.create({ name: "A1", path: join(directory, "A1") });
    await first.setStatus(created.id, "paused");
    await first.stop();

    const second = new ProjectRegistry(options);
    await second.start();
    expect(await second.list()).toMatchObject([{ id: created.id, name: "A1", status: "paused" }]);
    await second.stop();
  });
});
