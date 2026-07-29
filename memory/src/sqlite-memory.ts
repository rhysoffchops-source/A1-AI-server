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

import type {
  ConversationMessage,
  GraphEdge,
  GraphEntity,
  MemoryEngine,
  MemoryRecord,
  MemoryScope,
  MemorySearchResult,
  RememberInput,
  SearchMemoryInput
} from "./contracts.js";

interface MemoryRow {
  content: string;
  created_at: string;
  embedding_json: string | null;
  id: string;
  key: string;
  metadata_json: string;
  scope: MemoryScope;
  scope_id: string;
  updated_at: string;
}
interface MessageRow {
  content: string;
  conversation_id: string;
  created_at: string;
  id: string;
  metadata_json: string;
  role: ConversationMessage["role"];
}
interface EdgeRow {
  from_id: string;
  metadata_json: string;
  relation: string;
  to_id: string;
  updated_at: string;
}

function jsonObject(value: string): JsonObject {
  const parsed = JSON.parse(value) as unknown;
  assertJsonValue(parsed);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Stored metadata is not a JSON object.");
  }
  return parsed as JsonObject;
}
function vector(value: string | null): readonly number[] | undefined {
  if (value === null) return undefined;
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "number" || !Number.isFinite(item))
  ) {
    throw new TypeError("Stored embedding is invalid.");
  }
  return parsed as number[];
}
function memory(row: MemoryRow): MemoryRecord {
  const embedding = vector(row.embedding_json);
  return {
    content: row.content,
    createdAt: row.created_at,
    ...(embedding === undefined ? {} : { embedding }),
    id: row.id,
    key: row.key,
    metadata: jsonObject(row.metadata_json),
    scope: row.scope,
    scopeId: row.scope_id,
    updatedAt: row.updated_at
  };
}
function cosine(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return -1;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude === 0 || rightMagnitude === 0
    ? -1
    : dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

export interface SqliteMemoryOptions {
  readonly busyTimeoutMs: number;
  readonly filePath: string;
}

export class SqliteMemoryEngine implements MemoryEngine, LifecycleComponent {
  public readonly name = "memory-engine";
  #database: Database.Database | undefined;
  public constructor(private readonly options: SqliteMemoryOptions) {}

  public async open(): Promise<void> {
    if (this.#database !== undefined) throw new Error("Memory engine is already open.");
    await mkdir(dirname(this.options.filePath), { mode: 0o700, recursive: true });
    const database = new Database(this.options.filePath);
    database.pragma(`busy_timeout = ${String(this.options.busyTimeoutMs)}`);
    database.pragma("journal_mode = WAL");
    database.pragma("synchronous = FULL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('assistant','system','tool','user')),
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_messages_order
        ON conversation_messages(conversation_id, created_at, id);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL CHECK (scope IN ('agent','global','project','semantic')),
        scope_id TEXT NOT NULL,
        key TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        embedding_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, scope_id, key)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        key, content, content='memories', content_rowid='rowid'
      );
      CREATE TRIGGER IF NOT EXISTS memory_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(rowid, key, content) VALUES (new.rowid, new.key, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, content)
          VALUES('delete', old.rowid, old.key, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memory_fts(memory_fts, rowid, key, content)
          VALUES('delete', old.rowid, old.key, old.content);
        INSERT INTO memory_fts(rowid, key, content) VALUES (new.rowid, new.key, new.content);
      END;
      CREATE TABLE IF NOT EXISTS graph_entities (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS graph_edges (
        from_id TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        to_id TEXT NOT NULL REFERENCES graph_entities(id) ON DELETE CASCADE,
        metadata_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(from_id, relation, to_id)
      );
    `);
    this.#database = database;
  }

  public async close(): Promise<void> {
    await Promise.resolve();
    const database = this.#database;
    this.#database = undefined;
    database?.close();
  }

  public start(): Promise<void> {
    return this.open();
  }

  public stop(): Promise<void> {
    return this.close();
  }

  public health(): HealthCheckResult {
    if (this.#database === undefined) {
      return { message: "Memory database is closed.", status: "unhealthy" };
    }
    try {
      this.#database.prepare("SELECT 1").get();
      return { status: "healthy" };
    } catch (error: unknown) {
      return {
        message: error instanceof Error ? error.message : "Memory database health check failed.",
        status: "unhealthy"
      };
    }
  }

  public async addMessage(
    conversationId: string,
    role: ConversationMessage["role"],
    content: string,
    metadata: JsonObject = {}
  ): Promise<ConversationMessage> {
    await Promise.resolve();
    if (conversationId.trim() === "" || content.trim() === "")
      throw new TypeError("Conversation ID and content are required.");
    const database = this.#required();
    const now = new Date().toISOString();
    const id = randomUUID();
    database
      .transaction(() => {
        database
          .prepare(
            `INSERT INTO conversations(id, created_at, updated_at) VALUES(?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at=excluded.updated_at`
          )
          .run(conversationId, now, now);
        database
          .prepare(
            `INSERT INTO conversation_messages(id, conversation_id, role, content, metadata_json, created_at)
         VALUES(?, ?, ?, ?, ?, ?)`
          )
          .run(id, conversationId, role, content, canonicalJsonStringify(metadata), now);
      })
      .immediate();
    return { content, conversationId, createdAt: now, id, metadata, role };
  }

  public async conversation(
    conversationId: string,
    limit = 200
  ): Promise<readonly ConversationMessage[]> {
    await Promise.resolve();
    const rows = this.#required()
      .prepare(
        `SELECT *, rowid FROM (
        SELECT *, rowid FROM conversation_messages WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, rowid ASC`
      )
      .all(conversationId, limit) as MessageRow[];
    return rows.map((row) => ({
      content: row.content,
      conversationId: row.conversation_id,
      createdAt: row.created_at,
      id: row.id,
      metadata: jsonObject(row.metadata_json),
      role: row.role
    }));
  }

  public async remember(input: RememberInput): Promise<MemoryRecord> {
    await Promise.resolve();
    if (input.key.trim() === "" || input.scopeId.trim() === "" || input.content.trim() === "") {
      throw new TypeError("Memory key, scope ID, and content are required.");
    }
    if (input.embedding?.some((value) => !Number.isFinite(value)))
      throw new TypeError("Embedding values must be finite.");
    const database = this.#required();
    const now = new Date().toISOString();
    const existing = database
      .prepare("SELECT id, created_at FROM memories WHERE scope=? AND scope_id=? AND key=?")
      .get(input.scope, input.scopeId, input.key) as { id: string; created_at: string } | undefined;
    const id = existing?.id ?? randomUUID();
    database
      .prepare(
        `INSERT INTO memories(id, scope, scope_id, key, content, metadata_json, embedding_json, created_at, updated_at)
       VALUES(@id,@scope,@scopeId,@key,@content,@metadata,@embedding,@createdAt,@updatedAt)
       ON CONFLICT(scope,scope_id,key) DO UPDATE SET
         content=excluded.content, metadata_json=excluded.metadata_json,
         embedding_json=excluded.embedding_json, updated_at=excluded.updated_at`
      )
      .run({
        content: input.content,
        createdAt: existing?.created_at ?? now,
        embedding: input.embedding === undefined ? null : JSON.stringify(input.embedding),
        id,
        key: input.key,
        metadata: canonicalJsonStringify(input.metadata ?? {}),
        scope: input.scope,
        scopeId: input.scopeId,
        updatedAt: now
      });
    return this.#memoryById(id);
  }

  public async search(input: SearchMemoryInput): Promise<readonly MemorySearchResult[]> {
    await Promise.resolve();
    if (!Number.isSafeInteger(input.limit) || input.limit <= 0)
      throw new RangeError("Search limit must be positive.");
    const database = this.#required();
    const parameters: unknown[] = [];
    let where = "";
    if (input.scopes !== undefined && input.scopes.length > 0) {
      where = `WHERE ${input.scopes.map(() => "(m.scope=? AND m.scope_id=?)").join(" OR ")}`;
      for (const scope of input.scopes) parameters.push(scope.scope, scope.scopeId);
    }
    let rows: (MemoryRow & { text_score?: number })[];
    if (input.query !== undefined && input.query.trim() !== "") {
      const phrase = `"${input.query.trim().replaceAll('"', '""')}"`;
      rows = database
        .prepare(
          `SELECT m.*, -bm25(memory_fts) AS text_score
         FROM memory_fts JOIN memories m ON m.rowid=memory_fts.rowid
         ${where} ${where === "" ? "WHERE" : "AND"} memory_fts MATCH ?
         ORDER BY text_score DESC LIMIT ?`
        )
        .all(...parameters, phrase, Math.max(input.limit * 5, 50)) as (MemoryRow & {
        text_score?: number;
      })[];
    } else {
      rows = database
        .prepare(`SELECT m.* FROM memories m ${where}`)
        .all(...parameters) as MemoryRow[];
    }
    return rows
      .map((row) => {
        const record = memory(row);
        const vectorScore =
          input.embedding === undefined || record.embedding === undefined
            ? undefined
            : cosine(input.embedding, record.embedding);
        const textScore = row.text_score ?? 0;
        return { record, score: vectorScore ?? textScore };
      })
      .filter((result) => result.score >= 0 || input.embedding === undefined)
      .sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt))
      .slice(0, input.limit);
  }

  public async upsertEntity(entity: Omit<GraphEntity, "updatedAt">): Promise<GraphEntity> {
    await Promise.resolve();
    const updatedAt = new Date().toISOString();
    this.#required()
      .prepare(
        `INSERT INTO graph_entities(id,kind,name,metadata_json,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET kind=excluded.kind,name=excluded.name,
       metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`
      )
      .run(entity.id, entity.kind, entity.name, canonicalJsonStringify(entity.metadata), updatedAt);
    return { ...entity, updatedAt };
  }

  public async connect(edge: Omit<GraphEdge, "updatedAt">): Promise<GraphEdge> {
    await Promise.resolve();
    const updatedAt = new Date().toISOString();
    this.#required()
      .prepare(
        `INSERT INTO graph_edges(from_id,relation,to_id,metadata_json,updated_at) VALUES(?,?,?,?,?)
       ON CONFLICT(from_id,relation,to_id) DO UPDATE SET
       metadata_json=excluded.metadata_json,updated_at=excluded.updated_at`
      )
      .run(edge.fromId, edge.relation, edge.toId, canonicalJsonStringify(edge.metadata), updatedAt);
    return { ...edge, updatedAt };
  }

  public async neighbors(entityId: string, relation?: string): Promise<readonly GraphEdge[]> {
    await Promise.resolve();
    const rows = (
      relation === undefined
        ? this.#required()
            .prepare("SELECT * FROM graph_edges WHERE from_id=? OR to_id=?")
            .all(entityId, entityId)
        : this.#required()
            .prepare("SELECT * FROM graph_edges WHERE (from_id=? OR to_id=?) AND relation=?")
            .all(entityId, entityId, relation)
    ) as EdgeRow[];
    return rows.map((row) => ({
      fromId: row.from_id,
      metadata: jsonObject(row.metadata_json),
      relation: row.relation,
      toId: row.to_id,
      updatedAt: row.updated_at
    }));
  }

  #memoryById(id: string): MemoryRecord {
    const row = this.#required().prepare("SELECT * FROM memories WHERE id=?").get(id) as
      MemoryRow | undefined;
    if (row === undefined) throw new Error(`Memory "${id}" was not found.`);
    return memory(row);
  }
  #required(): Database.Database {
    if (this.#database === undefined) throw new Error("Memory engine is not open.");
    return this.#database;
  }
}
