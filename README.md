# A1

A1 is a modular autonomous-AI control plane for Apple Silicon development and Linux/CUDA execution.
Version 1.0 composes independently replaceable model, compute, storage, memory, MCP, plugin,
security, scheduling, monitoring, API, and dashboard subsystems without provider types leaking into
the kernel.

## Capabilities

- Automatic model routing by coding, reasoning, fast, vision, embedding, long-context, and
  local/cloud preference, with ordered fallback.
- OpenAI-compatible, Anthropic, and Gemini adapters. OpenAI-compatible endpoints include OpenAI,
  OpenRouter, Venice, Ollama, vLLM, llama.cpp, MLX, and future compatible services.
- Bounded autonomous agents with durable conversations, cancellation, permission-filtered tools, and
  audited execution.
- YAML-driven stdio and HTTP MCP servers with no integration-specific code paths.
- Persistent conversation, semantic, vector, full-text, project, agent, global, and knowledge-graph
  memory.
- Durable leased task scheduling with retries, timeouts, idempotency, recovery, and dead-terminal
  failure state.
- Local and S3-compatible storage for AWS S3, Backblaze B2, Cloudflare R2, and custom endpoints.
- Integrity-checked backups with consistent SQLite snapshots and atomic restore targets.
- Authentication, role/permission authorization, secret handles, AES-256-GCM local secrets,
  single-use approvals, and a tamper-evident audit chain.
- Vast.ai compute provisioning and hardened SSH execution through replaceable interfaces.
- Modern dark dashboard, live events, Prometheus metrics, dependency health, host telemetry, and
  NVIDIA GPU monitoring.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- macOS or Linux
- Docker with Compose v2 for container deployment
- Python 3.13 and CUDA only for project workloads that use them

## Install

```bash
./scripts/bootstrap.sh
```

The bootstrap performs a clean dependency install and the complete release verification pipeline.

## Run

```bash
npm start
```

Open [http://127.0.0.1:8787/](http://127.0.0.1:8787/) or inspect the service:

```bash
curl --fail http://127.0.0.1:8787/health/live
curl --fail http://127.0.0.1:8787/health/ready
curl --fail http://127.0.0.1:8787/metrics
```

For development:

```bash
npm run dev
```

For Docker:

```bash
docker compose -f docker/compose.yaml up --build
```

## Configure

Edit [`config/default.yaml`](config/default.yaml) or set `A1_CONFIG_PATH` to another YAML file.
Unknown keys and invalid values stop startup. Provider credentials are secret handles, never secret
values. A handle such as `openai.api-key` resolves from `A1_SECRET_OPENAI_API_KEY`.

The default configuration binds to loopback and disables authentication for local setup. Never bind
an authentication-disabled process to a public interface. See:

- [Provider configuration](docs/providers.md)
- [MCP configuration](docs/mcp.md)
- [HTTP API](docs/api.md)
- [Enrolled workers](docs/workers.md)
- [VPS, Modal, Vast, and Tailscale deployment kit](deploy/README.md)
- [Operations](docs/operations.md)
- [Security policy](SECURITY.md)
- [Architecture](docs/architecture.md)

## Verify

```bash
npm run verify
```

This checks formatting, strict lint rules, TypeScript project references, the production dashboard
bundle, all tests, and production compilation. CI runs the same command on macOS and Linux.

## Repository map

| Directory       | Responsibility                                              |
| --------------- | ----------------------------------------------------------- |
| `agents/`       | Autonomous agents and remote-compute adapters               |
| `api/`          | Composition root and versioned HTTP control plane           |
| `config/`       | Strict YAML schema, loading, overrides, and path resolution |
| `core/`         | Lifecycle, events, health, logging, and JSON contracts      |
| `databases/`    | SQLite task persistence and consistent snapshots            |
| `mcp/`          | Configurable MCP transports and registry                    |
| `memory/`       | Unified persistent memory and knowledge graph               |
| `models/`       | Provider adapters, catalog, routing, and fallback           |
| `monitoring/`   | Metrics, system telemetry, and GPU inspection               |
| `orchestrator/` | Durable scheduler and task contracts                        |
| `plugins/`      | Validated plugin lifecycle                                  |
| `projects/`     | Persistent project registry                                 |
| `security/`     | Identity, permissions, secrets, approvals, and audit        |
| `services/`     | Object storage, backup, and provider factories              |
| `tools/`        | Permission-aware tool registry                              |
| `ui/`           | Production TypeScript dashboard                             |
