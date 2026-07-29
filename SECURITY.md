# A1 security policy

## Reporting

Do not publish suspected vulnerabilities or credentials in an issue, log, commit, or chat
transcript. Record the affected component, observed behavior, impact, and a minimal reproduction
without including secret values.

## Credential handling

- Store only secret references in A1 configuration.
- Provide secret values through an approved secrets backend or process environment.
- Rotate a credential immediately if it appears in source control or logs.
- Never use production credentials in tests.

## Supported code

Only committed milestones on the main branch are supported. Security fixes are applied to the
current version first. Historical milestone packages are retained for rollback, not ongoing
maintenance.

## Baseline controls

The API binds to loopback by default, emits restrictive security headers, limits request body size,
enforces request timeouts, redacts common credential fields, and returns generic internal errors.
Authentication and authorization are mandatory before non-health management endpoints are exposed.

# Security architecture

A1 fails closed at each external boundary:

- non-health HTTP routes require a verified bearer token when authentication is enabled;
- token signatures use HMAC-SHA256 with a minimum 256-bit secret and fixed algorithm;
- authorization evaluates explicit principal and role permissions;
- destructive actions require a short-lived approval bound to the exact action and target;
- secret callers use named handles, never environment-variable names or backend APIs;
- the local secret store uses AES-256-GCM, restrictive permissions, and atomic replacement;
- lifecycle and task security events enter the tamper-evident audit chain.

Production authentication and encryption keys must be supplied through `A1_SECRET_*` environment
variables or a future external secret resolver. They must never be stored in YAML, source control,
logs, events, task payloads, or memory.
