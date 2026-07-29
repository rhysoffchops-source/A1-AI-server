# ADR 0011: Operational control plane

- Status: Accepted
- Date: 2026-07-28

## Context

A1's subsystems need one observable operating surface without coupling domain packages to HTTP or
the dashboard. Operators also need live state without polling every subsystem independently.

## Decision

The API process is the composition root. It injects narrow subsystem interfaces into versioned HTTP
routes and emits the existing typed domain-event stream over Server-Sent Events. The dashboard is a
separately built TypeScript application served as immutable static assets by the API.

Prometheus metrics, dependency health, system telemetry, and NVIDIA GPU inspection are independent
monitoring adapters. Project metadata has its own SQLite durability domain. Agent runs enter the
durable scheduler rather than executing in request handlers. Compute provisioning and release use a
replaceable compute port and require action-and-target-bound approval tokens because they incur cost
or destroy remote state.

## Consequences

- UI code has no direct database, provider, or filesystem access.
- Control-plane routes enforce the same identity and permission model as tools.
- Live events are transient; durable state remains authoritative after reconnect.
- Metrics can be scraped without loading the dashboard.
- Adding a dashboard view does not change a domain package contract.
- Online restore is intentionally prohibited; restoration is an offline maintenance operation.
