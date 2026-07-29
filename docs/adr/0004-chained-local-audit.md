# ADR 0004: Tamper-evident local audit chain

- Status: Accepted
- Date: 2026-07-28

## Context

Security-sensitive lifecycle and task operations require a durable record that can reveal local
modification or truncation after a restart. Audit policy must not couple domain services to a file
format or future external audit provider.

## Decision

Domain services use the `AuditRecorder` contract. The local `AuditSink` writes canonical JSON Lines
records containing a monotonic sequence, the previous record hash, the audit envelope, and a SHA-256
hash of the preceding fields.

Startup verifies the complete chain before accepting writes. A lock permits one writer per journal,
file permissions are restrictive, append operations are serialized, and synchronous mode flushes
each record before returning.

## Consequences

- Modification, reordering, and truncation relative to a previously observed head are detectable.
- Only one A1 process may write a local journal at a time.
- The chain does not provide an external timestamp or prevent an attacker from replacing the entire
  journal and its checkpoint.
- A future adapter can replicate records or anchor chain heads in an independent service without
  changing callers.
