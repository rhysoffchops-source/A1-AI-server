# ADR 0003: SQLite task store with renewable leases

- Status: Accepted
- Date: 2026-07-28

## Context

A1 needs a durable scheduler that survives restarts, supports cancellation and retries, and can
recover abandoned work without requiring an external service for a single-node installation. The
orchestrator must remain independent of a particular database.

## Decision

The orchestrator depends on a `TaskStore` port. The initial adapter uses SQLite in WAL mode with
full synchronization, a configured busy timeout, and immediate transactions for competing state
changes.

Claims assign a unique lease token, worker owner, and expiry. Running workers renew leases through
heartbeats. A replacement scheduler recovers expired retryable tasks, while tasks that exhausted
their attempt budget become terminal failures. Mutations by a worker require its current, unexpired
lease.

## Consequences

- A local A1 installation gains durable scheduling without operating another service.
- Multiple scheduler processes can safely compete for ready tasks.
- A future Postgres adapter can implement the same `TaskStore` contract.
- Handler side effects outside the task database still require their own idempotency strategy.
