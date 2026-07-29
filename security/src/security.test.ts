import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ApprovalGate } from "./approval.js";
import { HmacTokenService, PermissionAuthorizer, type Principal } from "./auth.js";
import { EncryptedFileSecretStore, EnvironmentSecretResolver } from "./secrets.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});
const principal: Principal = {
  id: "user-1",
  permissions: new Set(["project:read"]),
  roles: new Set(["operator"])
};

describe("security services", () => {
  it("issues, verifies, and rejects tampered authentication tokens", () => {
    const service = new HmacTokenService({
      audience: "a1-api",
      issuer: "a1",
      secret: randomBytes(32),
      ttlSeconds: 60
    });
    const token = service.issue(principal);
    expect(service.verify(token).id).toBe("user-1");
    expect(() => service.verify(`${token.slice(0, -1)}x`)).toThrow("signature");
  });

  it("authorizes explicit and role wildcard permissions", () => {
    const authorizer = new PermissionAuthorizer(
      new Map([["operator", new Set(["task:*"])]] as const)
    );
    expect(authorizer.allows(principal, "project:read")).toBe(true);
    expect(authorizer.allows(principal, "task:cancel")).toBe(true);
    expect(() => authorizer.require(principal, "secret:read")).toThrow("lacks permission");
  });

  it("persists encrypted secrets without plaintext", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-secrets-test-"));
    directories.push(directory);
    const path = join(directory, "secrets.json");
    const key = randomBytes(32);
    const store = new EncryptedFileSecretStore(path, key);
    await store.set("openai", "sensitive-value");
    expect(await store.resolve("openai")).toBe("sensitive-value");
    expect(await readFile(path, "utf8")).not.toContain("sensitive-value");
    expect(
      await new EnvironmentSecretResolver({ A1_SECRET_OPENAI: "environment" }).resolve("openai")
    ).toBe("environment");
  });

  it("consumes destructive-action approvals exactly once", () => {
    const gate = new ApprovalGate(ApprovalGate.generateSecret());
    const approval = gate.issue(principal, "project.delete", "project-1");
    expect(() => gate.consume(approval, "project.delete", "project-1")).not.toThrow();
    expect(() => gate.consume(approval, "project.delete", "project-1")).toThrow("already consumed");
  });
});
