# ADR 0008: Configurable MCP transports

- Status: Accepted
- Date: 2026-07-28

## Decision

MCP servers are data, not plugins compiled into A1. A strict YAML record selects stdio or Streamable
HTTP and supplies its transport parameters. The registry implements MCP initialization, discovery,
invocation, session handling, timeouts, permissions, and lifecycle once for every server.

## Consequences

- New MCP servers require configuration only.
- Tool names remain scoped by server identity.
- An enabled server that cannot initialize prevents readiness.
