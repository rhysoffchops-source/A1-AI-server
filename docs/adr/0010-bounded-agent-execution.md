# ADR 0010: Bounded agent execution

- Status: Accepted
- Date: 2026-07-28

## Context

Autonomous agents can amplify model mistakes when tool calls are unbounded or executed outside the
requesting identity's permission set. Provider APIs also encode tool history differently.

## Decision

The agent runner uses provider-neutral messages and a hard positive step limit. Every run receives a
fresh identity, cancellation signal, conversation namespace, and immutable permission grant. Tools
are discovered and invoked through a permission-enforcing registry that validates JSON at both
boundaries and records every invocation in the security audit journal.

Remote compute is represented by a replaceable provider port. The Vast.ai adapter provisions and
releases instances through its REST API. Remote command execution uses the operating system's SSH
client with batch mode, an explicit known-hosts file, argument quoting, and cancellation.

## Consequences

- Agents cannot expand their own permissions or continue past their configured step budget.
- Conversation and final-run memory survive process restarts.
- Model adapters must preserve assistant tool calls and tool responses in history.
- Provisioning credentials remain secret handles resolved only during composition.
- Destructive compute release must be exposed only behind A1's approval boundary.
