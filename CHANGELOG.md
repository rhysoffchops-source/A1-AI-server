# Changelog

All notable A1 changes are recorded here. Versions follow semantic versioning once the public
contract reaches `1.0.0`.

## 1.0.0 - 2026-07-28

### Added

- Fully composed control plane for models, agents, tools, MCP, memory, projects, storage, backups,
  authentication, authorization, approvals, health, and audit.
- Persistent project registry and versioned management API.
- Durable scheduled agent runs with configurable definitions and MCP tool discovery.
- Prometheus metrics, host telemetry, NVIDIA GPU monitoring, and dependency-aware system health.
- Live Server-Sent Events and a responsive dark operational dashboard for projects, agents, tasks,
  logs, models, memory, plugins, system health, and GPU state.
- Configuration-driven Vast.ai compute provisioning, observation, and approval-gated release.
- Consistent SQLite backup sources and operable backup create/list endpoints.
- Production container packaging for every workspace and the dashboard.

### Changed

- The root platform contract is stable at version 1.0.0.
- Full formatting, linting, typechecking, UI compilation, tests, and runtime smoke checks are
  release requirements.

## 0.8.0 - 2026-07-28

### Added

- Bounded autonomous agent runner with cancellation, durable run memory, and model fallback.
- Permission-filtered tool discovery, schema validation, execution, and tamper-evident audit
  records.
- Provider-neutral tool-call history across OpenAI-compatible, Anthropic, and Gemini adapters.
- Replaceable remote-compute contract and Vast.ai REST adapter.
- Hardened SSH remote execution with explicit host verification and cancellation.
- Strict YAML configuration for agent definitions and compute providers.

## 0.7.0 - 2026-07-28

### Added

- HMAC-SHA256 authentication tokens with strict issuer, audience, expiry, and claim validation.
- Explicit permission and role-based authorization with bounded wildcard grants.
- Environment secret resolution and atomic AES-256-GCM encrypted-file secret storage.
- Single-use, expiring approval tokens bound to destructive action and target.
- Optional bearer authentication for every non-health API route.

## 0.6.0 - 2026-07-28

### Added

- YAML-driven MCP registry with no server-specific code paths.
- MCP stdio transport with process lifecycle, initialization, timeouts, and request correlation.
- Streamable HTTP transport with session negotiation, JSON and SSE responses.
- Permission-gated startup, reverse shutdown, tool discovery, invocation, and readiness monitoring.
- Compatibility with filesystem, Git, GitHub, SQLite, Postgres, Docker, terminal, browser, PDF,
  HTTP, Slack, Notion, Google Drive, S3, and custom MCP servers.

## 0.5.0 - 2026-07-28

### Added

- Restart-safe conversation history with ordered messages and metadata.
- Scoped semantic, project, agent, and global persistent memory.
- Persistent embedding vectors with cosine-similarity retrieval.
- SQLite FTS5 full-text memory search.
- Durable knowledge-graph entities, typed relations, and neighbor traversal.
- Memory database readiness monitoring in the control-plane runtime.

## 0.4.0 - 2026-07-28

### Added

- Interchangeable object-storage contract with atomic local-disk implementation.
- S3-compatible adapter for AWS S3, Backblaze B2, Cloudflare R2, and custom endpoints.
- Integrity-checked backup manifests, content hashes, atomic restore targets, and pluggable sources.
- Strict storage-provider configuration using secret handles rather than embedded credentials.

## 0.3.0 - 2026-07-28

### Added

- Provider-neutral completion, streaming, embedding, multimodal, and tool-call contracts.
- OpenAI-compatible adapter for OpenAI, OpenRouter, Venice, Ollama, vLLM, llama.cpp, MLX, and future
  compatible endpoints.
- Native Anthropic and Gemini adapters.
- Model catalog with capability, context, location, provider, and priority metadata.
- Automatic capability routing with local/cloud preference and ordered provider fallback.
- Strict YAML configuration for provider and model registration without code changes.

## 0.2.0 - 2026-07-28

### Added

- Typed, ordered in-process event bus with immutable payloads and isolated subscriber failures.
- Durable task scheduler with idempotent enqueueing, atomic SQLite claims, renewable leases,
  cancellation, timeout enforcement, retry backoff, bounded concurrency, and restart recovery.
- SQLite task store using WAL mode, full synchronization, busy timeouts, and transactional state
  transitions.
- Plugin manifest schema and lifecycle manager with API compatibility, dependency ordering,
  permission enforcement, activation rollback, and reverse shutdown.
- Tamper-evident JSON Lines audit journal with canonical serialization, SHA-256 chaining,
  synchronous persistence, restart verification, and single-writer locking.
- Scheduler, plugin, and audit readiness checks in the control-plane API.
- Cross-subsystem integration tests for durable task execution and restart behavior.
- Architecture decisions covering renewable task leases and the local audit chain.

## 0.1.0 - 2026-07-28

### Added

- Complete A1 top-level repository structure.
- Strict TypeScript workspace and automated verification.
- Validated, immutable YAML configuration with environment overrides.
- Structured logging with credential redaction.
- Application lifecycle management with startup rollback and reverse shutdown.
- Dependency-aware health registry with enforced timeouts.
- Hardened Fastify control-plane API with liveness and readiness endpoints.
- Graceful signal and fatal-error handling.
- Multi-stage API container and local Compose deployment.
- macOS and Linux continuous integration.
- Architecture rules and accepted decisions for the hybrid runtime and adapter boundaries.
