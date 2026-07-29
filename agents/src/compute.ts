import { spawn } from "node:child_process";

import { assertJsonValue, type JsonObject } from "@a1/core";

export interface ComputeInstance {
  readonly id: string;
  readonly providerId: string;
  readonly sshHost?: string;
  readonly sshPort?: number;
  readonly status: string;
}
export interface ProvisionComputeInput {
  readonly diskGb: number;
  readonly environment?: Readonly<Record<string, string>>;
  readonly image: string;
  readonly offerId: string;
  readonly onStart?: string;
}
export interface ComputeProvider {
  readonly id: string;
  get(instanceId: string): Promise<ComputeInstance>;
  provision(input: ProvisionComputeInput): Promise<ComputeInstance>;
  release(instanceId: string): Promise<void>;
}

export interface VastAiProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly id: string;
  readonly timeoutMs: number;
}

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
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

export class VastAiProvider implements ComputeProvider {
  public readonly id: string;
  readonly #baseUrl: string;
  public constructor(private readonly options: VastAiProviderOptions) {
    this.id = options.id;
    this.#baseUrl = options.baseUrl ?? "https://console.vast.ai/api/v0/";
  }

  public async provision(input: ProvisionComputeInput): Promise<ComputeInstance> {
    const record = await this.#request(`asks/${encodeURIComponent(input.offerId)}`, {
      body: JSON.stringify({
        disk: input.diskGb,
        env: input.environment ?? {},
        image: input.image,
        ...(input.onStart === undefined ? {} : { onstart: input.onStart }),
        runtype: "ssh"
      }),
      method: "PUT"
    });
    const id = stringField(record.new_contract ?? record.id, "");
    if (id === "") throw new Error("Vast.ai did not return a contract ID.");
    return this.get(id);
  }

  public async get(instanceId: string): Promise<ComputeInstance> {
    const record = await this.#request(`instances/${encodeURIComponent(instanceId)}`, {
      method: "GET"
    });
    const instance =
      record.instances !== null &&
      typeof record.instances === "object" &&
      !Array.isArray(record.instances)
        ? (record.instances as JsonObject)
        : record;
    return {
      id: stringField(instance.id, instanceId),
      providerId: this.id,
      ...(typeof instance.ssh_host === "string" ? { sshHost: instance.ssh_host } : {}),
      ...(typeof instance.ssh_port === "number" ? { sshPort: instance.ssh_port } : {}),
      status: stringField(instance.actual_status ?? instance.status, "unknown")
    };
  }

  public async release(instanceId: string): Promise<void> {
    await this.#request(`instances/${encodeURIComponent(instanceId)}`, { method: "DELETE" });
  }

  async #request(path: string, init: RequestInit): Promise<JsonObject> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    timeout.unref();
    try {
      const response = await fetch(new URL(path, this.#baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          "content-type": "application/json"
        },
        signal: controller.signal
      });
      if (!response.ok)
        throw new Error(
          `Vast.ai HTTP ${String(response.status)}: ${(await response.text()).slice(0, 1000)}`
        );
      const value: unknown = await response.json();
      if (!isJsonObject(value)) throw new TypeError("Vast.ai returned invalid JSON.");
      return value;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export interface SshExecutionOptions {
  readonly host: string;
  readonly knownHostsFile: string;
  readonly port: number;
  readonly user: string;
}
export class SshRemoteExecutor {
  public execute(
    options: SshExecutionOptions,
    command: string,
    args: readonly string[],
    signal: AbortSignal
  ): Promise<{ readonly stderr: string; readonly stdout: string }> {
    return new Promise((resolve, reject) => {
      const remote = [command, ...args].map(shellQuote).join(" ");
      const child = spawn(
        "ssh",
        [
          "-o",
          "BatchMode=yes",
          "-o",
          `UserKnownHostsFile=${options.knownHostsFile}`,
          "-p",
          String(options.port),
          `${options.user}@${options.host}`,
          "--",
          remote
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      const abort = (): void => {
        child.kill("SIGTERM");
      };
      signal.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("exit", (code) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted)
          reject(signal.reason instanceof Error ? signal.reason : new Error("SSH cancelled."));
        else if (code === 0) resolve({ stderr, stdout });
        else reject(new Error(`SSH command exited with ${String(code)}: ${stderr.slice(0, 1000)}`));
      });
    });
  }
}
