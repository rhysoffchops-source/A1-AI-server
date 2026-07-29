import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import {
  assertJsonValue,
  canonicalJsonStringify,
  type HealthCheckResult,
  type JsonObject,
  type LifecycleComponent
} from "@a1/core";
import Database from "better-sqlite3";

export type WorkerCommandStatus = "failed" | "queued" | "running" | "succeeded";
export type WorkerPlatform = "linux" | "macos";
export type WorkerProjectVerificationStatus =
  "failed" | "passed" | "queued" | "running" | "unverified";
export type WorkerProjectReviewStatus = "approved" | "blocked" | "fix_required" | "unreviewed";
export type WorkerProjectLockStatus =
  "lock_failed" | "lock_queued" | "locked" | "unlock_queued" | "unlocked";
export type WorkerStatus = "offline" | "online";

export interface WorkerDefinition {
  readonly allowedRoots: readonly string[];
  readonly id: string;
  readonly name: string;
  readonly platform: WorkerPlatform;
}
export interface Worker {
  readonly allowedRoots: readonly string[];
  readonly id: string;
  readonly lastSeenAt?: string;
  readonly metadata: JsonObject;
  readonly name: string;
  readonly platform: WorkerPlatform;
  readonly status: WorkerStatus;
}
export interface WorkerCommand {
  readonly completedAt?: string;
  readonly createdAt: string;
  readonly id: string;
  readonly kind: string;
  readonly payload: JsonObject;
  readonly result?: JsonObject;
  readonly startedAt?: string;
  readonly status: WorkerCommandStatus;
  readonly workerId: string;
}
export interface WorkerProjectObservation {
  readonly branch: string;
  readonly changedFiles: number;
  readonly fingerprint: string;
  readonly path: string;
}
export interface WorkerProject extends WorkerProjectObservation {
  readonly lastSeenAt: string;
  readonly lockManifestPath?: string;
  readonly lockStatus: WorkerProjectLockStatus;
  readonly lockedAt?: string;
  readonly reviewFindings?: JsonObject;
  readonly reviewStatus: WorkerProjectReviewStatus;
  readonly reviewSummary?: string;
  readonly reviewedAt?: string;
  readonly reviewedFingerprint?: string;
  readonly lastVerifiedAt?: string;
  readonly lastVerifiedFingerprint?: string;
  readonly verificationStatus: WorkerProjectVerificationStatus;
  readonly workerId: string;
}
export interface RecordWorkerProjectReviewInput {
  readonly findings: JsonObject;
  readonly fingerprint: string;
  readonly path: string;
  readonly status: Exclude<WorkerProjectReviewStatus, "unreviewed">;
  readonly summary: string;
  readonly workerId: string;
}
export interface RecordWorkerProjectReviewResult {
  readonly cancelledWriteCommands: number;
  readonly lockCommand?: WorkerCommand;
  readonly project: WorkerProject;
}
export interface QueueWorkerCommandInput {
  readonly kind: string;
  readonly payload: JsonObject;
  readonly workerId: string;
}
export interface CompleteWorkerCommandInput {
  readonly commandId: string;
  readonly result: JsonObject;
  readonly status: Extract<WorkerCommandStatus, "failed" | "succeeded">;
  readonly workerId: string;
}
export interface WorkerRegistryOptions {
  readonly busyTimeoutMs: number;
  readonly definitions: readonly WorkerDefinition[];
  readonly filePath: string;
}

interface WorkerRow {
  readonly allowed_roots_json: string;
  readonly id: string;
  readonly last_seen_at: string | null;
  readonly metadata_json: string;
  readonly name: string;
  readonly platform: string;
  readonly status: string;
}
interface WorkerCommandRow {
  readonly completed_at: string | null;
  readonly created_at: string;
  readonly id: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly result_json: string | null;
  readonly started_at: string | null;
  readonly status: string;
  readonly worker_id: string;
}
interface WorkerProjectRow {
  readonly branch: string;
  readonly changed_files: number;
  readonly fingerprint: string;
  readonly last_seen_at: string;
  readonly last_verified_at: string | null;
  readonly last_verified_fingerprint: string | null;
  readonly lock_manifest_path: string | null;
  readonly lock_status: string;
  readonly locked_at: string | null;
  readonly path: string;
  readonly review_fingerprint: string | null;
  readonly review_findings_json: string | null;
  readonly review_status: string;
  readonly review_summary: string | null;
  readonly reviewed_at: string | null;
  readonly verification_status: string;
  readonly worker_id: string;
}

function jsonObject(value: unknown, message: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(message);
  }
  assertJsonValue(value, message);
  return value as JsonObject;
}
function stringArray(value: unknown, message: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new TypeError(message);
  }
  return value;
}
function workerStatus(value: string): WorkerStatus {
  if (value === "offline" || value === "online") return value;
  throw new TypeError("Worker database returned an invalid status.");
}
function workerPlatform(value: string): WorkerPlatform {
  if (value === "linux" || value === "macos") return value;
  throw new TypeError("Worker database returned an invalid platform.");
}
function commandStatus(value: string): WorkerCommandStatus {
  if (value === "failed" || value === "queued" || value === "running" || value === "succeeded") {
    return value;
  }
  throw new TypeError("Worker database returned an invalid command status.");
}
function projectVerificationStatus(value: string): WorkerProjectVerificationStatus {
  if (
    value === "failed" ||
    value === "passed" ||
    value === "queued" ||
    value === "running" ||
    value === "unverified"
  ) {
    return value;
  }
  throw new TypeError("Worker database returned an invalid project verification status.");
}
function projectReviewStatus(value: string): WorkerProjectReviewStatus {
  if (
    value === "approved" ||
    value === "blocked" ||
    value === "fix_required" ||
    value === "unreviewed"
  ) {
    return value;
  }
  throw new TypeError("Worker database returned an invalid project review status.");
}
function projectLockStatus(value: string): WorkerProjectLockStatus {
  if (
    value === "lock_failed" ||
    value === "lock_queued" ||
    value === "locked" ||
    value === "unlock_queued" ||
    value === "unlocked"
  ) {
    return value;
  }
  throw new TypeError("Worker database returned an invalid project lock status.");
}
function parseWorker(value: unknown): Worker {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker database returned an invalid row.");
  }
  const row = value as WorkerRow;
  const allowedRoots = stringArray(JSON.parse(row.allowed_roots_json), "Worker roots are invalid.");
  const metadata = jsonObject(JSON.parse(row.metadata_json), "Worker metadata is invalid.");
  return {
    allowedRoots,
    id: row.id,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    metadata,
    name: row.name,
    platform: workerPlatform(row.platform),
    status: workerStatus(row.status)
  };
}
function parseCommand(value: unknown): WorkerCommand {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker command database returned an invalid row.");
  }
  const row = value as WorkerCommandRow;
  return {
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    createdAt: row.created_at,
    id: row.id,
    kind: row.kind,
    payload: jsonObject(JSON.parse(row.payload_json), "Worker command payload is invalid."),
    ...(row.result_json === null
      ? {}
      : { result: jsonObject(JSON.parse(row.result_json), "Worker command result is invalid.") }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    status: commandStatus(row.status),
    workerId: row.worker_id
  };
}
function parseProject(value: unknown): WorkerProject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Worker project database returned an invalid row.");
  }
  const row = value as WorkerProjectRow;
  if (!Number.isSafeInteger(row.changed_files) || row.changed_files < 0) {
    throw new TypeError("Worker project database returned an invalid changed file count.");
  }
  return {
    branch: row.branch,
    changedFiles: row.changed_files,
    fingerprint: row.fingerprint,
    lastSeenAt: row.last_seen_at,
    ...(row.lock_manifest_path === null ? {} : { lockManifestPath: row.lock_manifest_path }),
    lockStatus: projectLockStatus(row.lock_status),
    ...(row.locked_at === null ? {} : { lockedAt: row.locked_at }),
    reviewStatus: projectReviewStatus(row.review_status),
    ...(row.review_summary === null ? {} : { reviewSummary: row.review_summary }),
    ...(row.reviewed_at === null ? {} : { reviewedAt: row.reviewed_at }),
    ...(row.review_fingerprint === null ? {} : { reviewedFingerprint: row.review_fingerprint }),
    ...(row.review_findings_json === null
      ? {}
      : {
          reviewFindings: jsonObject(
            JSON.parse(row.review_findings_json),
            "Worker review findings are invalid."
          )
        }),
    ...(row.last_verified_at === null ? {} : { lastVerifiedAt: row.last_verified_at }),
    ...(row.last_verified_fingerprint === null
      ? {}
      : { lastVerifiedFingerprint: row.last_verified_fingerprint }),
    path: row.path,
    verificationStatus: projectVerificationStatus(row.verification_status),
    workerId: row.worker_id
  };
}
function projectVerificationInput(
  command: WorkerCommand
): { readonly fingerprint: string; readonly path: string } | undefined {
  if (command.kind !== "project.verify") return undefined;
  const fingerprint = command.payload.fingerprint;
  const path = command.payload.path;
  if (typeof fingerprint !== "string" || typeof path !== "string") return undefined;
  return { fingerprint, path };
}
function projectLockInput(
  command: WorkerCommand
):
  | { readonly fingerprint?: string; readonly path: string; readonly type: "lock" | "unlock" }
  | undefined {
  if (command.kind !== "project.lock" && command.kind !== "project.unlock") return undefined;
  const path = command.payload.path;
  const fingerprint = command.payload.fingerprint;
  if (typeof path !== "string") return undefined;
  if (command.kind === "project.lock" && typeof fingerprint !== "string") return undefined;
  return {
    ...(typeof fingerprint === "string" ? { fingerprint } : {}),
    path,
    type: command.kind === "project.lock" ? "lock" : "unlock"
  };
}
function pathIsInside(candidate: string, projectPath: string): boolean {
  return candidate === projectPath || candidate.startsWith(`${projectPath}/`);
}

export class WorkerRegistry implements LifecycleComponent {
  public readonly name = "worker-registry";
  #database: Database.Database | undefined;

  public constructor(private readonly options: WorkerRegistryOptions) {}

  public async start(): Promise<void> {
    if (this.#database !== undefined) throw new Error("Worker registry is already started.");
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const database = new Database(this.options.filePath);
    database.pragma(`busy_timeout = ${String(this.options.busyTimeoutMs)}`);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform TEXT NOT NULL CHECK (platform IN ('linux', 'macos')),
        allowed_roots_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('offline', 'online')),
        last_seen_at TEXT,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS worker_commands (
        id TEXT PRIMARY KEY,
        worker_id TEXT NOT NULL REFERENCES workers(id),
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        result_json TEXT
      );
      CREATE INDEX IF NOT EXISTS worker_commands_claim ON worker_commands(worker_id, status, created_at ASC);
      CREATE TABLE IF NOT EXISTS worker_projects (
        worker_id TEXT NOT NULL REFERENCES workers(id),
        path TEXT NOT NULL,
        branch TEXT NOT NULL,
        changed_files INTEGER NOT NULL CHECK (changed_files >= 0),
        fingerprint TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        verification_status TEXT NOT NULL CHECK (verification_status IN ('unverified', 'queued', 'running', 'passed', 'failed')),
        last_verified_at TEXT,
        last_verified_fingerprint TEXT,
        review_status TEXT NOT NULL DEFAULT 'unreviewed' CHECK (review_status IN ('unreviewed', 'approved', 'fix_required', 'blocked')),
        reviewed_at TEXT,
        review_fingerprint TEXT,
        review_summary TEXT,
        review_findings_json TEXT,
        lock_status TEXT NOT NULL DEFAULT 'unlocked' CHECK (lock_status IN ('unlocked', 'lock_queued', 'locked', 'unlock_queued', 'lock_failed')),
        locked_at TEXT,
        lock_manifest_path TEXT,
        PRIMARY KEY (worker_id, path)
      );
      CREATE INDEX IF NOT EXISTS worker_projects_verification ON worker_projects(worker_id, verification_status, last_seen_at DESC);
    `);
    const addColumn = (definition: string): void => {
      try {
        database.exec(`ALTER TABLE worker_projects ADD COLUMN ${definition}`);
      } catch (error: unknown) {
        if (!(error instanceof Error) || !error.message.includes("duplicate column name"))
          throw error;
      }
    };
    addColumn("review_status TEXT NOT NULL DEFAULT 'unreviewed'");
    addColumn("reviewed_at TEXT");
    addColumn("review_fingerprint TEXT");
    addColumn("review_summary TEXT");
    addColumn("review_findings_json TEXT");
    addColumn("lock_status TEXT NOT NULL DEFAULT 'unlocked'");
    addColumn("locked_at TEXT");
    addColumn("lock_manifest_path TEXT");
    const insert = database.prepare(
      `INSERT INTO workers (id, name, platform, allowed_roots_json, status, metadata_json)
       VALUES (?, ?, ?, ?, 'offline', '{}')
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         platform = excluded.platform,
         allowed_roots_json = excluded.allowed_roots_json`
    );
    const persistDefinitions = database.transaction(() => {
      for (const definition of this.options.definitions) {
        insert.run(
          definition.id,
          definition.name,
          definition.platform,
          canonicalJsonStringify([...definition.allowedRoots])
        );
      }
    });
    persistDefinitions();
    this.#database = database;
  }

  public async stop(): Promise<void> {
    await Promise.resolve();
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  public async list(): Promise<readonly Worker[]> {
    await Promise.resolve();
    return this.#required()
      .prepare("SELECT * FROM workers ORDER BY name ASC, id ASC")
      .all()
      .map((row) => parseWorker(row));
  }

  public async get(id: string): Promise<Worker | undefined> {
    await Promise.resolve();
    const row = this.#required().prepare("SELECT * FROM workers WHERE id = ?").get(id);
    return row === undefined ? undefined : parseWorker(row);
  }

  public async heartbeat(id: string, metadata: JsonObject): Promise<Worker> {
    await Promise.resolve();
    assertJsonValue(metadata, "worker metadata");
    const updated = this.#required()
      .prepare(
        `UPDATE workers
         SET status = 'online', last_seen_at = ?, metadata_json = ?
         WHERE id = ?`
      )
      .run(new Date().toISOString(), canonicalJsonStringify(metadata), id);
    if (updated.changes === 0) throw new Error(`Worker "${id}" is not configured.`);
    const worker = await this.get(id);
    if (worker === undefined) throw new Error("Worker heartbeat was not durable.");
    return worker;
  }

  public async observeProjects(
    workerId: string,
    observations: readonly WorkerProjectObservation[]
  ): Promise<readonly WorkerProject[]> {
    await Promise.resolve();
    const worker = await this.get(workerId);
    if (worker === undefined) throw new Error(`Worker "${workerId}" is not configured.`);
    const uniquePaths = new Set<string>();
    for (const observation of observations) {
      if (
        observation.path.trim() === "" ||
        observation.fingerprint.trim() === "" ||
        observation.branch.trim() === "" ||
        !Number.isSafeInteger(observation.changedFiles) ||
        observation.changedFiles < 0
      ) {
        throw new TypeError("Worker project observation is invalid.");
      }
      if (uniquePaths.has(observation.path)) {
        throw new TypeError(`Worker project "${observation.path}" was reported more than once.`);
      }
      uniquePaths.add(observation.path);
      if (
        !worker.allowedRoots.some(
          (root) => observation.path === root || observation.path.startsWith(`${root}/`)
        )
      ) {
        throw new Error(`Worker project "${observation.path}" is outside the configured roots.`);
      }
    }
    const database = this.#required();
    const observedAt = new Date().toISOString();
    const record = database.transaction(() => {
      const existing = database.prepare(
        `SELECT fingerprint, verification_status
         FROM worker_projects WHERE worker_id = ? AND path = ?`
      );
      const insert = database.prepare(
        `INSERT INTO worker_projects
          (worker_id, path, branch, changed_files, fingerprint, last_seen_at, verification_status)
         VALUES (?, ?, ?, ?, ?, ?, 'unverified')`
      );
      const update = database.prepare(
        `UPDATE worker_projects
         SET branch = ?, changed_files = ?, fingerprint = ?, last_seen_at = ?,
             verification_status = CASE
               WHEN fingerprint <> ? AND verification_status NOT IN ('queued', 'running') THEN 'unverified'
               ELSE verification_status
             END,
             review_status = CASE WHEN fingerprint <> ? THEN 'unreviewed' ELSE review_status END,
             reviewed_at = CASE WHEN fingerprint <> ? THEN NULL ELSE reviewed_at END,
             review_fingerprint = CASE WHEN fingerprint <> ? THEN NULL ELSE review_fingerprint END,
             review_summary = CASE WHEN fingerprint <> ? THEN NULL ELSE review_summary END,
             review_findings_json = CASE WHEN fingerprint <> ? THEN NULL ELSE review_findings_json END
         WHERE worker_id = ? AND path = ?`
      );
      for (const observation of observations) {
        const current = existing.get(workerId, observation.path) as
          { fingerprint: string; verification_status: string } | undefined;
        if (current === undefined) {
          insert.run(
            workerId,
            observation.path,
            observation.branch,
            observation.changedFiles,
            observation.fingerprint,
            observedAt
          );
        } else {
          update.run(
            observation.branch,
            observation.changedFiles,
            observation.fingerprint,
            observedAt,
            observation.fingerprint,
            observation.fingerprint,
            observation.fingerprint,
            observation.fingerprint,
            observation.fingerprint,
            observation.fingerprint,
            workerId,
            observation.path
          );
        }
      }
    });
    record();
    await Promise.all(
      observations.map((observation) => this.queueProjectVerification(workerId, observation.path))
    );
    return this.listProjects(workerId);
  }

  public async listProjects(workerId?: string): Promise<readonly WorkerProject[]> {
    await Promise.resolve();
    const database = this.#required();
    const rows =
      workerId === undefined
        ? database
            .prepare(
              "SELECT * FROM worker_projects ORDER BY last_seen_at DESC, worker_id ASC, path ASC"
            )
            .all()
        : database
            .prepare(
              `SELECT * FROM worker_projects
               WHERE worker_id = ?
               ORDER BY last_seen_at DESC, path ASC`
            )
            .all(workerId);
    return rows.map((row) => parseProject(row));
  }

  public async getProject(
    workerId: string,
    projectPath: string
  ): Promise<WorkerProject | undefined> {
    await Promise.resolve();
    const row = this.#required()
      .prepare("SELECT * FROM worker_projects WHERE worker_id = ? AND path = ?")
      .get(workerId, projectPath);
    return row === undefined ? undefined : parseProject(row);
  }

  public async queueProjectVerification(
    workerId: string,
    projectPath: string
  ): Promise<WorkerCommand | undefined> {
    await Promise.resolve();
    const database = this.#required();
    const queue = database.transaction((): WorkerCommand | undefined => {
      const project = database
        .prepare(
          `SELECT * FROM worker_projects
           WHERE worker_id = ? AND path = ?`
        )
        .get(workerId, projectPath);
      if (project === undefined) return undefined;
      const parsedProject = parseProject(project);
      if (
        parsedProject.verificationStatus === "queued" ||
        parsedProject.verificationStatus === "running" ||
        parsedProject.lastVerifiedFingerprint === parsedProject.fingerprint
      ) {
        return undefined;
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const payload: JsonObject = {
        fingerprint: parsedProject.fingerprint,
        path: parsedProject.path
      };
      database
        .prepare(
          `INSERT INTO worker_commands (id, worker_id, kind, payload_json, status, created_at)
           VALUES (?, ?, 'project.verify', ?, 'queued', ?)`
        )
        .run(id, workerId, canonicalJsonStringify(payload), createdAt);
      database
        .prepare(
          `UPDATE worker_projects
           SET verification_status = 'queued'
           WHERE worker_id = ? AND path = ?`
        )
        .run(workerId, projectPath);
      return {
        createdAt,
        id,
        kind: "project.verify",
        payload,
        status: "queued",
        workerId
      };
    });
    return queue();
  }

  public async queue(input: QueueWorkerCommandInput): Promise<WorkerCommand> {
    await Promise.resolve();
    const workerId = input.workerId.trim();
    const kind = input.kind.trim();
    if (workerId === "" || kind === "")
      throw new TypeError("Worker ID and command kind are required.");
    assertJsonValue(input.payload, "worker command payload");
    if ((await this.get(workerId)) === undefined)
      throw new Error(`Worker "${workerId}" is not configured.`);
    if (kind === "shell") this.#requireProjectWriteAccess(workerId, input.payload);
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    this.#required()
      .prepare(
        `INSERT INTO worker_commands (id, worker_id, kind, payload_json, status, created_at)
         VALUES (?, ?, ?, ?, 'queued', ?)`
      )
      .run(id, workerId, kind, canonicalJsonStringify(input.payload), createdAt);
    const command = await this.getCommand(workerId, id);
    if (command === undefined) throw new Error("Worker command was not durable.");
    return command;
  }

  public async recordReview(
    input: RecordWorkerProjectReviewInput
  ): Promise<RecordWorkerProjectReviewResult> {
    await Promise.resolve();
    if (
      input.path.trim() === "" ||
      input.fingerprint.trim() === "" ||
      input.summary.trim() === ""
    ) {
      throw new TypeError("Worker project review is invalid.");
    }
    assertJsonValue(input.findings, "worker project review findings");
    const database = this.#required();
    const outcome = database.transaction(
      (): {
        readonly cancelledWriteCommands: number;
        readonly lockCommand?: WorkerCommand;
      } => {
        const existing = database
          .prepare("SELECT * FROM worker_projects WHERE worker_id = ? AND path = ?")
          .get(input.workerId, input.path);
        if (existing === undefined || parseProject(existing).fingerprint !== input.fingerprint) {
          throw new Error(
            "Code changed while the watchdog was reviewing it; a fresh review is required."
          );
        }
        const updated = database
          .prepare(
            `UPDATE worker_projects
           SET review_status = ?, reviewed_at = ?, review_fingerprint = ?, review_summary = ?, review_findings_json = ?
           WHERE worker_id = ? AND path = ? AND fingerprint = ?`
          )
          .run(
            input.status,
            new Date().toISOString(),
            input.fingerprint,
            input.summary,
            canonicalJsonStringify(input.findings),
            input.workerId,
            input.path,
            input.fingerprint
          );
        if (updated.changes !== 1) {
          throw new Error(
            "Code changed while the watchdog was reviewing it; a fresh review is required."
          );
        }
        const cancelledWriteCommands =
          input.status === "approved"
            ? 0
            : this.#cancelQueuedProjectWriteCommands(
                database,
                input.workerId,
                input.path,
                `Code Watchdog decision: ${input.status}. ${input.summary}`
              );
        const projectRow = database
          .prepare("SELECT * FROM worker_projects WHERE worker_id = ? AND path = ?")
          .get(input.workerId, input.path);
        if (projectRow === undefined) throw new Error("Worker project review was not durable.");
        const project = parseProject(projectRow);
        const lockCommand =
          input.status === "blocked"
            ? this.#queueProjectLock(database, project, input.summary)
            : undefined;
        return { cancelledWriteCommands, ...(lockCommand === undefined ? {} : { lockCommand }) };
      }
    )();
    const project = await this.getProject(input.workerId, input.path);
    if (project === undefined) throw new Error("Worker project review was not durable.");
    return { ...outcome, project };
  }

  public async requestProjectUnlock(workerId: string, projectPath: string): Promise<WorkerCommand> {
    await Promise.resolve();
    const database = this.#required();
    const command = database.transaction((): WorkerCommand => {
      const row = database
        .prepare("SELECT * FROM worker_projects WHERE worker_id = ? AND path = ?")
        .get(workerId, projectPath);
      if (row === undefined)
        throw new Error(`Project "${projectPath}" is not watched by worker "${workerId}".`);
      const project = parseProject(row);
      if (project.lockStatus !== "locked" || project.lockManifestPath === undefined) {
        throw new Error(`Project "${projectPath}" is not in a confirmed locked state.`);
      }
      const id = randomUUID();
      const createdAt = new Date().toISOString();
      const payload: JsonObject = { manifestPath: project.lockManifestPath, path: project.path };
      database
        .prepare(
          `INSERT INTO worker_commands (id, worker_id, kind, payload_json, status, created_at)
           VALUES (?, ?, 'project.unlock', ?, 'queued', ?)`
        )
        .run(id, workerId, canonicalJsonStringify(payload), createdAt);
      database
        .prepare(
          `UPDATE worker_projects
           SET lock_status = 'unlock_queued'
           WHERE worker_id = ? AND path = ?`
        )
        .run(workerId, projectPath);
      return { createdAt, id, kind: "project.unlock", payload, status: "queued", workerId };
    })();
    return command;
  }

  public async claim(workerId: string): Promise<WorkerCommand | undefined> {
    await Promise.resolve();
    const database = this.#required();
    const claim = database.transaction((): WorkerCommand | undefined => {
      const row = database
        .prepare(
          `SELECT * FROM worker_commands
           WHERE worker_id = ? AND status = 'queued'
           ORDER BY CASE kind WHEN 'project.lock' THEN 0 WHEN 'project.unlock' THEN 1 ELSE 2 END, created_at ASC
           LIMIT 1`
        )
        .get(workerId);
      if (row === undefined) return undefined;
      const parsed = parseCommand(row);
      const startedAt = new Date().toISOString();
      const updated = database
        .prepare(
          `UPDATE worker_commands SET status = 'running', started_at = ?
           WHERE id = ? AND worker_id = ? AND status = 'queued'`
        )
        .run(startedAt, parsed.id, workerId);
      if (updated.changes !== 1) return undefined;
      const verification = projectVerificationInput(parsed);
      if (verification !== undefined) {
        database
          .prepare(
            `UPDATE worker_projects
             SET verification_status = 'running'
             WHERE worker_id = ? AND path = ? AND verification_status = 'queued'`
          )
          .run(workerId, verification.path);
      }
      return { ...parsed, startedAt, status: "running" };
    });
    return claim();
  }

  public async complete(input: CompleteWorkerCommandInput): Promise<WorkerCommand> {
    await Promise.resolve();
    assertJsonValue(input.result, "worker command result");
    const completedAt = new Date().toISOString();
    const database = this.#required();
    const completion = database.transaction(
      (): {
        readonly staleVerificationPath?: string;
      } => {
        const row = database
          .prepare("SELECT * FROM worker_commands WHERE id = ? AND worker_id = ?")
          .get(input.commandId, input.workerId);
        if (row === undefined)
          throw new Error(`Worker command "${input.commandId}" cannot be completed.`);
        const command = parseCommand(row);
        if (command.status !== "running") {
          throw new Error(`Worker command "${input.commandId}" cannot be completed.`);
        }
        database
          .prepare(
            `UPDATE worker_commands
           SET status = ?, completed_at = ?, result_json = ?
           WHERE id = ? AND worker_id = ? AND status = 'running'`
          )
          .run(
            input.status,
            completedAt,
            canonicalJsonStringify(input.result),
            input.commandId,
            input.workerId
          );
        const verification = projectVerificationInput(command);
        if (verification !== undefined) {
          const projectRow = database
            .prepare("SELECT fingerprint FROM worker_projects WHERE worker_id = ? AND path = ?")
            .get(input.workerId, verification.path) as { fingerprint: string } | undefined;
          if (projectRow?.fingerprint !== verification.fingerprint) {
            database
              .prepare(
                `UPDATE worker_projects
               SET verification_status = 'unverified'
               WHERE worker_id = ? AND path = ?`
              )
              .run(input.workerId, verification.path);
            return { staleVerificationPath: verification.path };
          }
          database
            .prepare(
              `UPDATE worker_projects
             SET verification_status = ?, last_verified_at = ?, last_verified_fingerprint = ?
             WHERE worker_id = ? AND path = ?`
            )
            .run(
              input.status === "succeeded" ? "passed" : "failed",
              completedAt,
              verification.fingerprint,
              input.workerId,
              verification.path
            );
          return {};
        }
        const lock = projectLockInput(command);
        if (lock === undefined) return {};
        if (lock.type === "lock") {
          const manifestPath = input.result.manifestPath;
          const locked = input.status === "succeeded" && typeof manifestPath === "string";
          database
            .prepare(
              `UPDATE worker_projects
             SET lock_status = ?, locked_at = ?, lock_manifest_path = ?
             WHERE worker_id = ? AND path = ?${lock.fingerprint === undefined ? "" : " AND fingerprint = ?"}`
            )
            .run(
              locked ? "locked" : "lock_failed",
              locked ? completedAt : null,
              locked ? manifestPath : null,
              input.workerId,
              lock.path,
              ...(lock.fingerprint === undefined ? [] : [lock.fingerprint])
            );
        } else {
          database
            .prepare(
              `UPDATE worker_projects
             SET lock_status = ?, locked_at = NULL, lock_manifest_path = NULL
             WHERE worker_id = ? AND path = ?`
            )
            .run(input.status === "succeeded" ? "unlocked" : "locked", input.workerId, lock.path);
        }
        return {};
      }
    )();
    if (completion.staleVerificationPath !== undefined) {
      await this.queueProjectVerification(input.workerId, completion.staleVerificationPath);
    }
    const command = await this.getCommand(input.workerId, input.commandId);
    if (command === undefined) throw new Error("Worker command completion was not durable.");
    return command;
  }

  public async getCommand(workerId: string, commandId: string): Promise<WorkerCommand | undefined> {
    await Promise.resolve();
    const row = this.#required()
      .prepare("SELECT * FROM worker_commands WHERE worker_id = ? AND id = ?")
      .get(workerId, commandId);
    return row === undefined ? undefined : parseCommand(row);
  }

  public async listCommands(workerId: string, limit = 50): Promise<readonly WorkerCommand[]> {
    await Promise.resolve();
    if (!Number.isSafeInteger(limit) || limit <= 0)
      throw new RangeError("Worker command limit is invalid.");
    return this.#required()
      .prepare(
        `SELECT * FROM worker_commands
         WHERE worker_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(workerId, limit)
      .map((row) => parseCommand(row));
  }

  public health(): HealthCheckResult {
    try {
      this.#required().prepare("SELECT 1").get();
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        message: error instanceof Error ? error.message : "Worker registry is unavailable.",
        status: "unhealthy"
      };
    }
  }

  #required(): Database.Database {
    if (this.#database === undefined) throw new Error("Worker registry is not started.");
    return this.#database;
  }

  #requireProjectWriteAccess(workerId: string, payload: JsonObject): void {
    const candidate = typeof payload.cwd === "string" ? payload.cwd : payload.path;
    if (typeof candidate !== "string" || candidate.trim() === "") {
      throw new TypeError("A write-capable shell command must provide a project cwd or path.");
    }
    const watched = this.#required()
      .prepare(
        `SELECT * FROM worker_projects
         WHERE worker_id = ?`
      )
      .all(workerId)
      .map((row) => parseProject(row))
      .filter((project) => pathIsInside(candidate, project.path));
    if (watched.length === 0) {
      throw new Error(
        "A1 refuses write-capable shell commands outside an explicitly watched project root. Enrol and verify the project first."
      );
    }
    const project = watched.sort((left, right) => right.path.length - left.path.length)[0];
    if (project === undefined) throw new Error("No watched project matched this command path.");
    if (
      project.verificationStatus !== "passed" ||
      project.lastVerifiedFingerprint !== project.fingerprint ||
      project.reviewStatus !== "approved" ||
      project.reviewedFingerprint !== project.fingerprint ||
      project.lockStatus !== "unlocked"
    ) {
      throw new Error(
        `Project "${project.path}" is not write-authorized for its current code fingerprint. ` +
          "A passing verifier result and Code Watchdog approval are required; a physical lock also requires explicit unlock."
      );
    }
  }

  #cancelQueuedProjectWriteCommands(
    database: Database.Database,
    workerId: string,
    projectPath: string,
    reason: string
  ): number {
    const queued = database
      .prepare(
        `SELECT * FROM worker_commands
         WHERE worker_id = ? AND kind = 'shell' AND status = 'queued'`
      )
      .all(workerId)
      .map((row) => parseCommand(row))
      .filter((command) => {
        const candidate = command.payload.cwd ?? command.payload.path;
        return typeof candidate === "string" && pathIsInside(candidate, projectPath);
      });
    const completedAt = new Date().toISOString();
    const fail = database.prepare(
      `UPDATE worker_commands
       SET status = 'failed', completed_at = ?, result_json = ?
       WHERE id = ? AND worker_id = ? AND status = 'queued'`
    );
    for (const command of queued) {
      fail.run(
        completedAt,
        canonicalJsonStringify({ blockedByCodeWatchdog: true, reason }),
        command.id,
        workerId
      );
    }
    return queued.length;
  }

  #queueProjectLock(
    database: Database.Database,
    project: WorkerProject,
    reason: string
  ): WorkerCommand | undefined {
    if (project.lockStatus === "lock_queued" || project.lockStatus === "locked") return undefined;
    const id = randomUUID();
    const createdAt = new Date().toISOString();
    const payload: JsonObject = {
      fingerprint: project.fingerprint,
      path: project.path,
      reason
    };
    database
      .prepare(
        `INSERT INTO worker_commands (id, worker_id, kind, payload_json, status, created_at)
         VALUES (?, ?, 'project.lock', ?, 'queued', ?)`
      )
      .run(id, project.workerId, canonicalJsonStringify(payload), createdAt);
    database
      .prepare(
        `UPDATE worker_projects
         SET lock_status = 'lock_queued'
         WHERE worker_id = ? AND path = ? AND fingerprint = ?`
      )
      .run(project.workerId, project.path, project.fingerprint);
    return {
      createdAt,
      id,
      kind: "project.lock",
      payload,
      status: "queued",
      workerId: project.workerId
    };
  }
}
