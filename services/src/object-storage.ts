import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface StoredObject {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly etag?: string;
  readonly metadata: Readonly<Record<string, string>>;
}
export interface ObjectSummary {
  readonly key: string;
  readonly lastModified?: Date;
  readonly size: number;
}
export interface PutObjectInput {
  readonly body: Uint8Array;
  readonly contentType?: string;
  readonly key: string;
  readonly metadata?: Readonly<Record<string, string>>;
}
export interface ObjectStorage {
  delete(key: string): Promise<void>;
  get(key: string): Promise<StoredObject | undefined>;
  list(prefix?: string): Promise<readonly ObjectSummary[]>;
  put(input: PutObjectInput): Promise<void>;
}

export function normalizeObjectKey(key: string): string {
  const normalized = key.replaceAll("\\", "/").replace(/^\/+/u, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new TypeError(`Invalid object key "${key}".`);
  }
  return normalized;
}

function inside(root: string, key: string): string {
  const path = resolve(root, ...normalizeObjectKey(key).split("/"));
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new TypeError("Object key escapes the storage root.");
  }
  return path;
}

export class LocalObjectStorage implements ObjectStorage {
  readonly #root: string;
  public constructor(root: string) {
    this.#root = resolve(root);
  }

  public async put(input: PutObjectInput): Promise<void> {
    const path = inside(this.#root, input.key);
    await mkdir(dirname(path), { mode: 0o700, recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(input.body);
      await handle.sync();
      await handle.close();
      await rename(temporary, path);
      await this.#writeMetadata(path, input);
    } catch (error: unknown) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  public async get(key: string): Promise<StoredObject | undefined> {
    const path = inside(this.#root, key);
    try {
      const [body, metadata] = await Promise.all([
        readFile(path),
        this.#readMetadata(path).catch(
          (): { readonly contentType?: string; readonly values?: Record<string, string> } => ({})
        )
      ]);
      return {
        body,
        ...(metadata.contentType === undefined ? {} : { contentType: metadata.contentType }),
        metadata: metadata.values ?? {}
      };
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  public async delete(key: string): Promise<void> {
    const path = inside(this.#root, key);
    await Promise.all([
      unlink(path).catch((error: unknown) => {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }),
      unlink(`${path}.a1meta.json`).catch(() => undefined)
    ]);
  }

  public async list(prefix = ""): Promise<readonly ObjectSummary[]> {
    const normalizedPrefix = prefix === "" ? "" : normalizeObjectKey(prefix);
    const output: ObjectSummary[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (!entry.name.endsWith(".a1meta.json") && !entry.name.endsWith(".tmp")) {
          const key = relative(this.#root, path).split(sep).join("/");
          if (key.startsWith(normalizedPrefix)) {
            const details = await stat(path);
            output.push({ key, lastModified: details.mtime, size: details.size });
          }
        }
      }
    };
    await walk(this.#root);
    return output.sort((a, b) => a.key.localeCompare(b.key));
  }

  async #writeMetadata(path: string, input: PutObjectInput): Promise<void> {
    const value = JSON.stringify({
      ...(input.contentType === undefined ? {} : { contentType: input.contentType }),
      values: input.metadata ?? {}
    });
    const handle = await open(`${path}.a1meta.json`, "w", 0o600);
    try {
      await handle.writeFile(value, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #readMetadata(
    path: string
  ): Promise<{ readonly contentType?: string; readonly values?: Record<string, string> }> {
    return JSON.parse(await readFile(`${path}.a1meta.json`, "utf8")) as {
      contentType?: string;
      values?: Record<string, string>;
    };
  }
}
