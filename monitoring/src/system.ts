import { execFile } from "node:child_process";
import { cpus, freemem, loadavg, platform, totalmem, uptime } from "node:os";
import { promisify } from "node:util";

const executeFile = promisify(execFile);

export interface GpuSnapshot {
  readonly index: number;
  readonly memoryTotalMb: number;
  readonly memoryUsedMb: number;
  readonly name: string;
  readonly temperatureCelsius: number;
  readonly utilizationPercent: number;
}
export interface GpuMonitor {
  inspect(): Promise<readonly GpuSnapshot[]>;
}

function finite(value: string | undefined, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`nvidia-smi returned invalid ${field}.`);
  return number;
}

export class NvidiaSmiGpuMonitor implements GpuMonitor {
  public async inspect(): Promise<readonly GpuSnapshot[]> {
    try {
      const { stdout } = await executeFile(
        "nvidia-smi",
        [
          "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
          "--format=csv,noheader,nounits"
        ],
        { timeout: 5_000 }
      );
      return stdout
        .trim()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => {
          const fields = line.split(",").map((field) => field.trim());
          if (fields.length !== 6) throw new TypeError("nvidia-smi returned an invalid row.");
          return {
            index: finite(fields[0], "GPU index"),
            memoryTotalMb: finite(fields[4], "total memory"),
            memoryUsedMb: finite(fields[3], "used memory"),
            name: fields[1] ?? "NVIDIA GPU",
            temperatureCelsius: finite(fields[5], "temperature"),
            utilizationPercent: finite(fields[2], "utilization")
          };
        });
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }
}

export function systemSnapshot(): {
  readonly cpuCount: number;
  readonly freeMemoryBytes: number;
  readonly loadAverage: readonly number[];
  readonly platform: NodeJS.Platform;
  readonly systemUptimeSeconds: number;
  readonly totalMemoryBytes: number;
} {
  return {
    cpuCount: cpus().length,
    freeMemoryBytes: freemem(),
    loadAverage: loadavg(),
    platform: platform(),
    systemUptimeSeconds: uptime(),
    totalMemoryBytes: totalmem()
  };
}
