# ADR 0002: Ports and adapters for replaceable subsystems

- Status: Accepted
- Date: 2026-07-28

## Context

A1 must support multiple AI, storage, database, MCP, secret, and compute providers without
hardcoding any one provider into the platform. Provider SDK types tend to spread through a codebase
and make replacement expensive.

## Decision

Every external dependency is accessed through a capability-focused port owned by the consuming
domain. Provider integrations are adapters selected by validated configuration during service
composition.

Provider-specific logic, SDK types, environment variable names, request payloads, and error objects
remain inside the adapter package. Domain contracts expose normalized capabilities, results, usage,
and failures.

## Consequences

- Adding a provider does not modify kernel or domain logic.
- Adapter contract tests are mandatory.
- Lowest-common-denominator interfaces are avoided; optional capabilities are explicit.
- Provider escape hatches may exist only as opaque, namespaced adapter configuration.
- Service composition is the only layer allowed to choose concrete implementations.
