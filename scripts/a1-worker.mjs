#!/usr/bin/env node

import { execFile as executeFile } from "node:child_process";
import console from "node:console";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(executeFile);
const commandTimeoutMs = 10 * 60_000;
const maxOutputBytes = 512 * 1024;

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}
function positiveInteger(value, fallback) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error("Polling interval must be positive.");
  return parsed;
}
function paths(name) {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") return [];
  return value
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter((item) => item !== "")
    .map((item) => path.resolve(item));
}
function truncate(value) {
  return value.length <= maxOutputBytes
    ? value
    : `${value.slice(0, maxOutputBytes)}\n… output truncated by A1 worker`;
}
function fingerprint(value) {
  return createHash("sha256").update(value).digest("hex");
}
function isInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
function wait(milliseconds) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

const controlUrl = requiredEnvironment("A1_WORKER_CONTROL_URL").replace(/\/$/u, "");
const workerId = requiredEnvironment("A1_WORKER_ID");
const token = requiredEnvironment("A1_WORKER_TOKEN");
const allowedRoots = paths("A1_WORKER_ALLOWED_ROOTS");
const projectRoots = paths("A1_WORKER_PROJECT_ROOTS");
const pollIntervalMs = positiveInteger(process.env.A1_WORKER_POLL_INTERVAL_MS, 3_000);
const heartbeatIntervalMs = positiveInteger(process.env.A1_WORKER_HEARTBEAT_INTERVAL_MS, 60_000);
const shellEnabled = process.env.A1_WORKER_ALLOW_SHELL === "true";
const discoveryDepth = positiveInteger(process.env.A1_WORKER_DISCOVERY_DEPTH, 3);
const lockDirectory = path.resolve(
  process.env.A1_WORKER_LOCK_DIRECTORY?.trim() || path.join(os.homedir(), ".a1-worker-locks")
);

if (allowedRoots.length === 0) {
  throw new Error("A1_WORKER_ALLOWED_ROOTS must name at least one approved absolute directory.");
}
if (projectRoots.length === 0) {
  throw new Error(
    "A1_WORKER_PROJECT_ROOTS must name at least one managed project or workspace directory."
  );
}
for (const projectRoot of projectRoots) {
  if (
    !allowedRoots.some(
      (root) => projectRoot === root || projectRoot.startsWith(`${root}${path.sep}`)
    )
  ) {
    throw new Error(`Project root ${projectRoot} is outside A1_WORKER_ALLOWED_ROOTS.`);
  }
}

function inApprovedRoot(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required.`);
  const resolved = path.resolve(value);
  if (
    !allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))
  ) {
    throw new Error(`${label} must be inside an approved worker root.`);
  }
  return resolved;
}
async function isGitProject(directory) {
  try {
    await access(path.join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}
async function gitProjectsBelow(directory, remainingDepth) {
  if (await isGitProject(directory)) return [directory];
  if (remainingDepth === 0) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const ignored = new Set([
    ".git",
    ".next",
    ".venv",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "venv"
  ]);
  const nested = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !ignored.has(entry.name))
      .map((entry) => gitProjectsBelow(path.join(directory, entry.name), remainingDepth - 1))
  );
  return nested.flat();
}
async function managedProjectRoots() {
  const discovered = await Promise.all(
    projectRoots.map((projectRoot) => gitProjectsBelow(projectRoot, discoveryDepth))
  );
  return [...new Set(discovered.flat())].sort();
}
async function request(route, options = {}) {
  const response = await globalThis.fetch(`${controlUrl}${route}`, {
    ...options,
    headers: {
      authorization: `Worker ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      ...(options.headers ?? {})
    }
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`A1 worker request ${response.status}: ${truncate(detail)}`);
  }
  return response;
}
async function run(program, args, cwd) {
  const startedAt = Date.now();
  try {
    const { stderr, stdout } = await execFile(program, args, {
      cwd,
      maxBuffer: maxOutputBytes,
      timeout: commandTimeoutMs,
      windowsHide: true
    });
    return {
      durationMs: Date.now() - startedAt,
      exitCode: 0,
      stderr: truncate(stderr),
      stdout: truncate(stdout)
    };
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    const record = /** @type {{ code?: unknown; stderr?: unknown; stdout?: unknown }} */ (failure);
    return {
      durationMs: Date.now() - startedAt,
      exitCode: typeof record.code === "number" ? record.code : 1,
      stderr: truncate(typeof record.stderr === "string" ? record.stderr : failure.message),
      stdout: truncate(typeof record.stdout === "string" ? record.stdout : "")
    };
  }
}
function safeProjectPath(projectRoot, relativePath) {
  if (relativePath === "" || path.isAbsolute(relativePath)) {
    throw new Error("Git returned an unsafe source path.");
  }
  const target = path.resolve(projectRoot, relativePath);
  if (!isInside(target, projectRoot))
    throw new Error("Git returned a source path outside the project.");
  return target;
}
async function gitSourceFiles(projectRoot) {
  try {
    const { stdout } = await execFile("git", ["ls-files", "-co", "--exclude-standard", "-z"], {
      cwd: projectRoot,
      maxBuffer: 16 * 1024 * 1024,
      timeout: commandTimeoutMs,
      windowsHide: true
    });
    return stdout
      .split("\u0000")
      .filter((entry) => entry !== "")
      .sort();
  } catch (error) {
    throw new Error(
      `Could not enumerate project source: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}
async function fileContentHash(filePath) {
  const details = await lstat(filePath);
  const hash = createHash("sha256");
  if (details.isSymbolicLink()) {
    hash.update("symlink\u0000");
    hash.update(await readlink(filePath));
    return hash.digest("hex");
  }
  if (!details.isFile()) {
    hash.update(`non-file:${String(details.mode)}`);
    return hash.digest("hex");
  }
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}
async function sourceFingerprint(projectRoot, files) {
  const hash = createHash("sha256");
  for (const relativePath of files) {
    const target = safeProjectPath(projectRoot, relativePath);
    hash.update(relativePath);
    hash.update("\u0000");
    hash.update(await fileContentHash(target));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}
async function gitSnapshot(projectRoot) {
  try {
    await access(path.join(projectRoot, ".git"));
  } catch {
    return {
      branch: "(not a git project)",
      changedFiles: 0,
      fingerprint: fingerprint(`not-git:${projectRoot}`),
      path: projectRoot,
      state: "not-a-git-project"
    };
  }
  const [branch, status, files] = await Promise.all([
    run("git", ["branch", "--show-current"], projectRoot),
    run("git", ["status", "--porcelain=v1", "-z"], projectRoot),
    gitSourceFiles(projectRoot)
  ]);
  return {
    branch:
      branch.exitCode === 0 && branch.stdout.trim() !== "" ? branch.stdout.trim() : "(detached)",
    changedFiles: status.stdout.split("\u0000").filter((entry) => entry !== "").length,
    fingerprint: await sourceFingerprint(projectRoot, files),
    path: projectRoot,
    state: status.exitCode === 0 ? "ready" : "unavailable"
  };
}
async function reviewContext(projectRoot, snapshot) {
  const [diff, status] = await Promise.all([
    run("git", ["diff", "--no-ext-diff", "--binary", "HEAD", "--"], projectRoot),
    run("git", ["status", "--short"], projectRoot)
  ]);
  const policyNames = ["AGENTS.md", "CONTRIBUTING.md", "README.md"];
  const policies = Object.fromEntries(
    await Promise.all(
      policyNames.map(async (name) => {
        try {
          return [name, truncate(await readFile(path.join(projectRoot, name), "utf8"))];
        } catch {
          return [name, undefined];
        }
      })
    )
  );
  return {
    branch: snapshot.branch,
    changedFiles: snapshot.changedFiles,
    diff: { exitCode: diff.exitCode, stderr: diff.stderr, stdout: diff.stdout },
    fingerprint: snapshot.fingerprint,
    policies,
    status: { exitCode: status.exitCode, stderr: status.stderr, stdout: status.stdout }
  };
}
async function heartbeat() {
  const projects = await Promise.all(
    (await managedProjectRoots()).map((projectRoot) => gitSnapshot(projectRoot))
  );
  await request(`/api/v1/workers/${encodeURIComponent(workerId)}/heartbeat`, {
    body: JSON.stringify({
      metadata: {
        allowShell: shellEnabled,
        arch: process.arch,
        hostname: os.hostname(),
        node: process.version,
        platform: process.platform,
        projects,
        uptimeSeconds: Math.round(os.uptime())
      }
    }),
    method: "POST"
  });
}
async function verifyProject(payload) {
  const projectPath = inApprovedRoot(payload.path, "path");
  let scripts = {};
  try {
    const packageJson = JSON.parse(await readFile(path.join(projectPath, "package.json"), "utf8"));
    scripts = packageJson.scripts ?? {};
  } catch {
    // A source tree does not need to be a Node project. git diff --check is still useful.
  }
  let verification;
  if (typeof scripts.verify === "string") {
    verification = await run("npm", ["run", "verify"], projectPath);
  } else if (typeof scripts.test === "string") {
    verification = await run("npm", ["test"], projectPath);
  } else {
    verification = await run("git", ["diff", "--check"], projectPath);
  }
  const projectObservation = await gitSnapshot(projectPath);
  return {
    ...verification,
    fingerprintMatches: projectObservation.fingerprint === payload.fingerprint,
    projectObservation,
    reviewContext: await reviewContext(projectPath, projectObservation)
  };
}
function manifestPathFor(projectPath, fingerprintValue) {
  return path.join(
    lockDirectory,
    `${fingerprint(`${projectPath}\u0000${fingerprintValue}`).slice(0, 24)}-${fingerprintValue.slice(0, 16)}.json`
  );
}
function lockEntryPath(projectPath, relativePath) {
  if (relativePath === ".") return projectPath;
  return safeProjectPath(projectPath, relativePath);
}
async function lockEntries(projectPath) {
  const files = await gitSourceFiles(projectPath);
  const entries = new Map();
  const add = async (relativePath, type) => {
    if (entries.has(relativePath)) return;
    const target = lockEntryPath(projectPath, relativePath);
    const details = await lstat(target);
    if (details.isSymbolicLink()) return;
    if (
      (type === "directory" && !details.isDirectory()) ||
      (type === "file" && !details.isFile())
    ) {
      return;
    }
    entries.set(relativePath, { mode: details.mode & 0o7777, relativePath, type });
  };
  await add(".", "directory");
  for (const relativePath of files) {
    const target = safeProjectPath(projectPath, relativePath);
    await add(relativePath, "file");
    let directory = path.dirname(target);
    while (isInside(directory, projectPath)) {
      const relativeDirectory = path.relative(projectPath, directory) || ".";
      await add(relativeDirectory, "directory");
      if (directory === projectPath) break;
      directory = path.dirname(directory);
    }
  }
  return [...entries.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath)
  );
}
function parseLockManifest(value, projectPath) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Lock manifest is invalid.");
  }
  if (value.projectPath !== projectPath || !Array.isArray(value.entries)) {
    throw new Error("Lock manifest does not belong to this project.");
  }
  const entries = value.entries.map((entry) => {
    if (
      entry === null ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      typeof entry.relativePath !== "string" ||
      (entry.type !== "file" && entry.type !== "directory") ||
      typeof entry.mode !== "number" ||
      !Number.isSafeInteger(entry.mode)
    ) {
      throw new Error("Lock manifest contains an invalid entry.");
    }
    lockEntryPath(projectPath, entry.relativePath);
    return { mode: entry.mode, relativePath: entry.relativePath, type: entry.type };
  });
  return { entries, fingerprint: value.fingerprint, projectPath: value.projectPath };
}
async function lockProject(payload) {
  const projectPath = inApprovedRoot(payload.path, "path");
  if (typeof payload.fingerprint !== "string" || payload.fingerprint.trim() === "") {
    throw new Error("fingerprint is required to lock a project.");
  }
  if (isInside(lockDirectory, projectPath)) {
    throw new Error("A1_WORKER_LOCK_DIRECTORY must be outside every locked project.");
  }
  const snapshot = await gitSnapshot(projectPath);
  if (snapshot.fingerprint !== payload.fingerprint) {
    throw new Error(
      "Project code changed before the lock could be applied; a fresh review is required."
    );
  }
  const manifestPath = manifestPathFor(projectPath, snapshot.fingerprint);
  try {
    const existing = parseLockManifest(
      JSON.parse(await readFile(manifestPath, "utf8")),
      projectPath
    );
    if (existing.fingerprint === snapshot.fingerprint) {
      return { manifestPath, projectObservation: snapshot, sourceEntries: existing.entries.length };
    }
    throw new Error("A conflicting lock manifest already exists.");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  const entries = await lockEntries(projectPath);
  const manifest = {
    createdAt: new Date().toISOString(),
    entries,
    fingerprint: snapshot.fingerprint,
    projectPath,
    version: 1
  };
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${manifestPath}.${String(process.pid)}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(manifest), { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, manifestPath);
  const applied = [];
  try {
    for (const entry of [...entries].sort(
      (left, right) => right.relativePath.length - left.relativePath.length
    )) {
      const target = lockEntryPath(projectPath, entry.relativePath);
      await chmod(target, entry.mode & ~0o222);
      applied.push(entry);
    }
  } catch (error) {
    const restoration = await Promise.allSettled(
      applied.map(async (entry) =>
        chmod(lockEntryPath(projectPath, entry.relativePath), entry.mode)
      )
    );
    await rm(manifestPath, { force: true });
    if (restoration.some((result) => result.status === "rejected")) {
      throw new Error("Lock failed and the automatic permission restoration was incomplete.", {
        cause: error
      });
    }
    throw error;
  }
  return { manifestPath, projectObservation: snapshot, sourceEntries: entries.length };
}
async function unlockProject(payload) {
  const projectPath = inApprovedRoot(payload.path, "path");
  if (typeof payload.manifestPath !== "string" || payload.manifestPath.trim() === "") {
    throw new Error("manifestPath is required to unlock a project.");
  }
  const manifestPath = path.resolve(payload.manifestPath);
  if (!isInside(manifestPath, lockDirectory)) {
    throw new Error("The requested lock manifest is outside A1_WORKER_LOCK_DIRECTORY.");
  }
  const manifest = parseLockManifest(JSON.parse(await readFile(manifestPath, "utf8")), projectPath);
  for (const entry of [...manifest.entries].sort(
    (left, right) => left.relativePath.length - right.relativePath.length
  )) {
    const target = lockEntryPath(projectPath, entry.relativePath);
    try {
      await chmod(target, entry.mode);
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
    }
  }
  await rm(manifestPath, { force: true });
  return {
    projectObservation: await gitSnapshot(projectPath),
    restoredEntries: manifest.entries.length,
    unlocked: true
  };
}
async function execute(command) {
  if (command.kind === "system.inspect") {
    return {
      result: {
        arch: process.arch,
        freeMemoryBytes: os.freemem(),
        hostname: os.hostname(),
        platform: process.platform,
        totalMemoryBytes: os.totalmem(),
        uptimeSeconds: Math.round(os.uptime())
      },
      status: "succeeded"
    };
  }
  if (command.kind === "project.verify") {
    const result = await verifyProject(command.payload);
    return {
      result,
      status: result.exitCode === 0 && result.fingerprintMatches ? "succeeded" : "failed"
    };
  }
  if (command.kind === "project.lock") {
    return { result: await lockProject(command.payload), status: "succeeded" };
  }
  if (command.kind === "project.unlock") {
    return { result: await unlockProject(command.payload), status: "succeeded" };
  }
  if (command.kind === "shell") {
    if (!shellEnabled) throw new Error("Shell commands are disabled on this worker.");
    const cwd = inApprovedRoot(command.payload.cwd, "cwd");
    const source = command.payload.command;
    if (typeof source !== "string" || source.trim() === "") throw new Error("command is required.");
    if (source.length > 16_000) throw new Error("command is too long.");
    const result = await run("/bin/sh", ["-lc", source], cwd);
    return { result, status: result.exitCode === 0 ? "succeeded" : "failed" };
  }
  throw new Error(`Unsupported worker command ${String(command.kind)}.`);
}
async function poll() {
  const response = await request(`/api/v1/workers/${encodeURIComponent(workerId)}/poll`, {
    body: "{}",
    method: "POST"
  });
  if (response.status === 204) return undefined;
  const body = await response.json();
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.command === undefined
  ) {
    throw new Error("A1 returned an invalid worker command.");
  }
  return body.command;
}
async function complete(command, outcome) {
  await request(
    `/api/v1/workers/${encodeURIComponent(workerId)}/commands/${encodeURIComponent(command.id)}/result`,
    {
      body: JSON.stringify(outcome),
      method: "POST"
    }
  );
}

let nextHeartbeatAt = 0;
console.log(`A1 worker ${workerId} connected to ${controlUrl}`);
for (;;) {
  try {
    if (Date.now() >= nextHeartbeatAt) {
      await heartbeat();
      nextHeartbeatAt = Date.now() + heartbeatIntervalMs;
    }
    const command = await poll();
    if (command === undefined) {
      await wait(pollIntervalMs);
      continue;
    }
    try {
      await complete(command, await execute(command));
    } catch (error) {
      await complete(command, {
        result: { error: error instanceof Error ? error.message : String(error) },
        status: "failed"
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    await wait(Math.max(pollIntervalMs, 10_000));
  }
}
