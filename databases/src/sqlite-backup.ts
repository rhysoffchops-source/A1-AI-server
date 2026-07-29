import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import Database from "better-sqlite3";

export class SqliteBackupSource {
  public constructor(
    public readonly name: string,
    private readonly filePath: string
  ) {}

  public async snapshot(): Promise<Uint8Array> {
    const directory = await mkdtemp(join(tmpdir(), "a1-sqlite-backup-"));
    const destination = join(directory, basename(this.filePath));
    const database = new Database(this.filePath, { fileMustExist: true, readonly: true });
    try {
      await database.backup(destination);
      return await readFile(destination);
    } finally {
      database.close();
      await rm(directory, { force: true, recursive: true });
    }
  }
}
