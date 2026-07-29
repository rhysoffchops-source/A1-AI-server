import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { SqliteBackupSource } from "./sqlite-backup.js";

describe("SqliteBackupSource", () => {
  it("creates a consistent SQLite snapshot", async () => {
    const directory = await mkdtemp(join(tmpdir(), "a1-sqlite-snapshot-"));
    const source = join(directory, "source.sqlite");
    const restored = join(directory, "restored.sqlite");
    const database = new Database(source);
    database.exec(
      "CREATE TABLE values_table (value TEXT NOT NULL); INSERT INTO values_table VALUES ('durable');"
    );
    database.close();
    try {
      const body = await new SqliteBackupSource("database", source).snapshot();
      await writeFile(restored, body);
      const copy = new Database(restored, { readonly: true });
      const row = copy.prepare("SELECT value FROM values_table").get() as {
        readonly value: string;
      };
      copy.close();
      expect(row.value).toBe("durable");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
