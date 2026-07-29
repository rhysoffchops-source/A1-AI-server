# ADR 0005: Provider-neutral model routing

- Status: Accepted
- Date: 2026-07-28

## Decision

All inference consumers use A1 model contracts. Provider wire formats exist only inside adapters.
Models declare capabilities, context limits, location, priority, and provider ownership in
configuration. The router filters by hard requirements, applies location preference, and attempts
compatible candidates in deterministic priority order.

OpenAI-compatible services share one configurable adapter. Anthropic and Gemini use native adapters
because their protocols differ materially.

## Consequences

- Providers and endpoints can be replaced without changing agents or memory services.
- Local and cloud fallbacks follow the same routing policy.
- Unsupported operations fail at the adapter boundary and can route to another provider.
