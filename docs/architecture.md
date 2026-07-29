# A1 architecture

## System shape

A1 uses a hybrid architecture:

- the TypeScript control plane owns orchestration, API contracts, configuration, policy, scheduling,
  plugins, MCP connectivity, and the dashboard;
- Python workers own workloads that materially benefit from the Python ML ecosystem;
- local and remote workers communicate through versioned, transport-neutral contracts;
- every external capability is reached through a port implemented by an adapter.

This keeps macOS development fast while allowing CUDA workloads to execute on Vast.ai or another
replaceable compute provider.

## Dependency direction

Dependencies point inward:

1. `core/` defines kernel contracts and runtime primitives.
2. Domain subsystems define their own ports and domain types.
3. Adapters implement those ports for providers, databases, protocols, or transports.
4. `services/` composes implementations.
5. `api/`, `ui/`, and worker entry points are delivery mechanisms.

The kernel does not import provider SDKs. Domain code does not inspect environment variables.
Adapters do not select themselves. Composition is configuration-driven.

Cross-subsystem communication uses typed commands, queries, and events. Direct imports between
concrete adapters are prohibited.

## Runtime boundaries

| Boundary       | Contract                                                            |
| -------------- | ------------------------------------------------------------------- |
| Model provider | Completion, streaming, embedding, image, and capability interfaces  |
| Model router   | Policy input and ranked route result                                |
| Storage        | Object read/write/list/delete, metadata, and atomicity capabilities |
| Memory         | Store, retrieve, search, graph traversal, retention, and provenance |
| MCP            | Server definition, capability discovery, invocation, and lifecycle  |
| Plugin         | Manifest, compatibility, permissions, activation, and deactivation  |
| Compute        | Provision, execute, observe, cancel, and release                    |
| Secrets        | Resolve named secret handles without exposing backend details       |
| Database       | Repository and unit-of-work ports                                   |
| Eventing       | Typed publish/subscribe with delivery and retry semantics           |

Capability interfaces are deliberately narrower than provider APIs. Provider-specific options are
kept in validated adapter configuration and never leak into domain contracts.

## Milestone 1 implementation

The first durable kernel slice is composed in the API process:

- `core/` provides an ordered event bus whose JSON payloads are cloned and frozen before delivery;
- `orchestrator/` owns task policy and depends only on a `TaskStore` port;
- `databases/` implements that port with SQLite, atomic claims, and renewable leases;
- `plugins/` validates manifests and manages dependency-aware activation as a transaction;
- `security/` writes canonical audit envelopes to a verified hash chain.

The scheduler database and audit journal are separate durability domains. A task state change and
its audit record cannot share a transaction, so task state remains authoritative for execution and
audit records remain authoritative for security review. Every transition is designed to be safely
replayed or reconstructed after a process interruption.

## Configuration

YAML is the human-managed source of configuration. Environment variables override deploy-time
settings. Configuration is parsed once at process startup, validated strictly, frozen, and passed
into composition. Invalid or unknown settings fail closed.

Future dynamic configuration must be versioned, authenticated, audited, and transactionally
activated. It must not mutate the startup configuration object.

## Reliability rules

- Startup is ordered and fails atomically; already-started components are rolled back.
- Shutdown occurs in reverse order and has a configured deadline.
- Liveness means the process event loop can respond.
- Readiness reflects registered required dependencies.
- Logs are structured and redact common credential fields.
- Unhandled process failures mark a non-zero exit and initiate graceful shutdown.
- Persistent mutations require idempotency keys or an equivalent deduplication mechanism.
- Background tasks require explicit retry, timeout, cancellation, and dead-letter policies.

## Security rules

- No secret values in source control, YAML, logs, task payloads, or events.
- Authentication proves identity; authorization evaluates explicit permissions.
- Plugins, MCP servers, agents, and tools operate with declared least-privilege grants.
- Destructive operations require policy approval and auditable intent.
- Provider credentials are resolved by secret handles at the adapter boundary.
- External input is untrusted and must be schema-validated.

## Milestone sequence

Each milestone ends with a runnable, tested system and an atomic commit.

| Milestone | Deliverable                                                                             |
| --------- | --------------------------------------------------------------------------------------- |
| 0         | Repository foundation, configuration, logging, lifecycle, health, API, Docker, CI       |
| 1         | Kernel event bus, durable task scheduler, plugin lifecycle, audit envelope — Complete   |
| 2         | Provider-neutral model contracts, adapters, catalog, routing, fallbacks — Complete      |
| 3         | Storage ports/adapters, migrations, backup/restore foundation — Complete                |
| 4         | Conversation, semantic, project, agent, persistent, vector, graph memory — Complete     |
| 5         | YAML-driven MCP registry, lifecycle, permissions, integrations — Complete               |
| 6         | Authentication, authorization, secrets, approvals, security audit — Complete            |
| 7         | Agent orchestrator, tools, remote compute workers, cancellation and recovery — Complete |
| 8         | Dashboard, live event transport, monitoring, GPU telemetry, hardening — Complete        |

Milestone scopes may be split when implementation size would make review unsafe. Changes to accepted
architecture require an architecture decision record.
