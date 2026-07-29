import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface SecretResolver {
  resolve(handle: string): Promise<string | undefined>;
}

export class EnvironmentSecretResolver implements SecretResolver {
  public constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly prefix = "A1_SECRET_"
  ) {}
  public resolve(handle: string): Promise<string | undefined> {
    const key = `${this.prefix}${handle.replaceAll(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
    return Promise.resolve(this.environment[key]);
  }
}

export class CompositeSecretResolver implements SecretResolver {
  public constructor(private readonly resolvers: readonly SecretResolver[]) {}
  public async resolve(handle: string): Promise<string | undefined> {
    for (const resolver of this.resolvers) {
      const value = await resolver.resolve(handle);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}

interface EncryptedValue {
  readonly authTag: string;
  readonly ciphertext: string;
  readonly iv: string;
}
interface SecretFile {
  readonly secrets: Readonly<Record<string, EncryptedValue>>;
  readonly version: 1;
}

export class EncryptedFileSecretStore implements SecretResolver {
  readonly #key: Buffer;
  public constructor(
    private readonly filePath: string,
    key: Uint8Array
  ) {
    if (key.byteLength !== 32) throw new RangeError("Secret-store key must be exactly 32 bytes.");
    this.#key = Buffer.from(key);
  }

  public async resolve(handle: string): Promise<string | undefined> {
    const stored = (await this.#read()).secrets[handle];
    if (stored === undefined) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(stored.iv, "base64"));
    decipher.setAuthTag(Buffer.from(stored.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(stored.ciphertext, "base64")),
      decipher.final()
    ]).toString("utf8");
  }

  public async set(handle: string, value: string): Promise<void> {
    if (handle.trim() === "" || value.length === 0)
      throw new TypeError("Secret handle and value are required.");
    const file = await this.#read();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    await this.#write({
      secrets: {
        ...file.secrets,
        [handle]: {
          authTag: cipher.getAuthTag().toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          iv: iv.toString("base64")
        }
      },
      version: 1
    });
  }

  public async delete(handle: string): Promise<boolean> {
    const file = await this.#read();
    if (file.secrets[handle] === undefined) return false;
    const secrets = Object.fromEntries(
      Object.entries(file.secrets).filter(([candidate]) => candidate !== handle)
    );
    await this.#write({ secrets, version: 1 });
    return true;
  }

  async #read(): Promise<SecretFile> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      if (
        value === null ||
        typeof value !== "object" ||
        (value as Record<string, unknown>).version !== 1
      ) {
        throw new TypeError("Encrypted secret store has an unsupported format.");
      }
      return value as SecretFile;
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return { secrets: {}, version: 1 };
      }
      throw error;
    }
  }

  async #write(file: SecretFile): Promise<void> {
    await mkdir(dirname(this.filePath), { mode: 0o700, recursive: true });
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(file), "utf8");
      await handle.sync();
      await handle.close();
      await rename(temporary, this.filePath);
    } catch (error: unknown) {
      await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
