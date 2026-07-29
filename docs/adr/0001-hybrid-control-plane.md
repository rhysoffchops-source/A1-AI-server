# ADR 0001: TypeScript control plane with Python ML workers

- Status: Accepted
- Date: 2026-07-28

## Context

A1 must provide a strongly typed API, dashboard, plugins, MCP connectivity, orchestration, and
long-running services on Apple Silicon. It must also execute model and data workloads on local Apple
hardware and remote Linux/CUDA machines. The JavaScript ecosystem is strongest for the control-plane
surface, while Python remains strongest for ML execution.

## Decision

The control plane is implemented in strict TypeScript on Node.js 22 or newer. ML workloads are
implemented as Python 3.13 workers only when a workload needs the Python ecosystem. Boundaries
between the two runtimes use versioned schemas and transport-neutral service contracts.

Python packages cannot be imported by control-plane code, and TypeScript implementation details
cannot be assumed by workers.

## Consequences

- Control-plane code shares types across the API, orchestration, plugins, and UI.
- Python is not installed until a real worker exists.
- Local MLX and remote CUDA implementations can evolve independently.
- Contract compatibility and serialization require explicit tests.
- In-process shortcuts across the runtime boundary are not allowed.
