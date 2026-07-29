import { describe, expect, it } from "vitest";

import { MetricsRegistry } from "./metrics.js";

describe("MetricsRegistry", () => {
  it("renders deterministic Prometheus text", () => {
    const metrics = new MetricsRegistry();
    metrics.gauge("a1_ready", "Readiness").set(1);
    metrics.counter("a1_requests_total", "Requests").increment(2);
    expect(metrics.render()).toContain("a1_ready 1");
    expect(metrics.render()).toContain("# TYPE a1_requests_total counter");
    expect(metrics.render()).toContain("a1_requests_total 2");
  });
});
