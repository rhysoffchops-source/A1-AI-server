import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import {
  assertJsonValue,
  canonicalJsonStringify,
  type HealthCheckResult,
  type JsonObject,
  type LifecycleComponent
} from "@a1/core";
import Database from "better-sqlite3";

export type ProjectStatus = "active" | "archived" | "paused";
export interface Project {
  readonly createdAt: string;
  readonly id: string;
  readonly metadata: JsonObject;
  readonly name: string;
  readonly path: string;
  readonly status: ProjectStatus;
  readonly updatedAt: string;
}
export interface CreateProjectInput {
  readonly metadata?: JsonObject;
  readonly name: string;
  readonly path: string;
}

interface ProjectRow {
  readonly created_at: string;
  readonly id: string;
  readonly metadata_json: string;
  readonly name: string;
  readonly path: string;
  readonly status: string;
  readonly updated_at: string;
}

function isJsonObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    assertJsonValue(value);
    return true;
  } catch {
    return false;
  }
}

function parseRow(value: unknown): Project {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Project database returned an invalid row.");
  }
  const row = value as ProjectRow;
  if (row.status !== "active" && row.status !== "archived" && row.status !== "paused") {
    throw new TypeError(`Project "${row.id}" has an invalid status.`);
  }
  const metadata: unknown = JSON.parse(row.metadata_json);
  if (!isJsonObject(metadata)) {
    throw new TypeError("Project metadata must be an object.");
  }
  return {
    createdAt: row.created_at,
    id: row.id,
    metadata,
    name: row.name,
    path: row.path,
    status: row.status,
    updatedAt: row.updated_at
  };
}

export interface ProjectRegistryOptions {
  readonly busyTimeoutMs: number;
  readonly filePath: string;
}

export class ProjectRegistry implements LifecycleComponent {
  public readonly name = "project-registry";
  #database: Database.Database | undefined;

  public constructor(private readonly options: ProjectRegistryOptions) {}

  public async start(): Promise<void> {
    if (this.#database !== undefined) throw new Error("Project registry is already started.");
    await mkdir(dirname(this.options.filePath), { recursive: true });
    const database = new Database(this.options.filePath);
    database.pragma(`busy_timeout = ${String(this.options.busyTimeoutMs)}`);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK (status IN ('active', 'archived', 'paused')),
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS projects_status_updated ON projects(status, updated_at DESC);
    `);
    this.#database = database;
  }

  public async stop(): Promise<void> {
    await Promise.resolve();
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  public async create(input: CreateProjectInput): Promise<Project> {
    await Promise.resolve();
    const name = input.name.trim();
    const path = normalize(input.path);
    if (name === "") throw new TypeError("Project name is required.");
    if (!isAbsolute(path)) throw new TypeError("Project path must be absolute.");
    const metadata = input.metadata ?? {};
    assertJsonValue(metadata, "project metadata");
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.#required()
      .prepare(
        `INSERT INTO projects (id, name, path, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?)`
      )
      .run(id, name, path, canonicalJsonStringify(metadata), timestamp, timestamp);
    const created = await this.get(id);
    if (created === undefined) throw new Error("Project creation was not durable.");
    return created;
  }

  public async get(id: string): Promise<Project | undefined> {
    await Promise.resolve();
    const value = this.#required().prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return value === undefined ? undefined : parseRow(value);
  }

  public async list(): Promise<readonly Project[]> {
    await Promise.resolve();
    return this.#required()
      .prepare("SELECT * FROM projects ORDER BY updated_at DESC, name ASC")
      .all()
      .map((value) => parseRow(value));
  }

  public async setStatus(id: string, status: ProjectStatus): Promise<Project | undefined> {
    await Promise.resolve();
    const updatedAt = new Date().toISOString();
    const result = this.#required()
      .prepare("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, updatedAt, id);
    return result.changes === 0 ? undefined : this.get(id);
  }

  public health(): HealthCheckResult {
    try {
      this.#required().prepare("SELECT 1").get();
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        message: error instanceof Error ? error.message : "Project registry is unavailable.",
        status: "unhealthy"
      };
    }
  }

  #required(): Database.Database {
    if (this.#database === undefined) throw new Error("Project registry is not started.");
    return this.#database;
  }
}
