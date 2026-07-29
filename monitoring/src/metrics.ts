function metricName(value: string): string {
  if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(value)) {
    throw new TypeError(`Invalid metric name "${value}".`);
  }
  return value;
}

interface Metric {
  readonly help: string;
  readonly type: "counter" | "gauge";
  value: number;
}

export class MetricsRegistry {
  readonly #values = new Map<string, Metric>();

  public counter(name: string, help: string): { increment(value?: number): void } {
    const metric = this.#register(name, help, "counter");
    return {
      increment: (value = 1): void => {
        if (!Number.isFinite(value) || value < 0) {
          throw new RangeError("Counter increments must be non-negative.");
        }
        metric.value += value;
      }
    };
  }

  public gauge(name: string, help: string): { set(value: number): void } {
    const metric = this.#register(name, help, "gauge");
    return {
      set: (value): void => {
        if (!Number.isFinite(value)) throw new RangeError("Gauge values must be finite.");
        metric.value = value;
      }
    };
  }

  public render(): string {
    return [...this.#values.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .flatMap(([name, metric]) => [
        `# HELP ${name} ${metric.help.replaceAll("\n", " ")}`,
        `# TYPE ${name} ${metric.type}`,
        `${name} ${String(metric.value)}`
      ])
      .join("\n")
      .concat("\n");
  }

  #register(nameValue: string, help: string, type: Metric["type"]): Metric {
    const name = metricName(nameValue);
    const existing = this.#values.get(name);
    if (existing !== undefined) {
      if (existing.type !== type) throw new Error(`Metric "${name}" has a conflicting type.`);
      return existing;
    }
    const metric: Metric = { help, type, value: 0 };
    this.#values.set(name, metric);
    return metric;
  }
}
