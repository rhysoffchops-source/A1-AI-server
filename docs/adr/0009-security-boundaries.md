# ADR 0009: Authentication, authorization, secrets, and approvals

- Status: Accepted
- Date: 2026-07-28

## Decision

Authentication verifies identity and token integrity. Authorization separately evaluates explicit
permissions and role grants. Destructive operations additionally consume a short-lived approval
bound to one action and target.

Services resolve named secret handles through a backend interface. Environment resolution is the
deployment baseline; the local managed store encrypts every value with AES-256-GCM under an
externally supplied 256-bit master key.

## Consequences

- Possession of a valid token does not imply broad authorization.
- Approval tokens cannot be repurposed or reused within a running control plane.
- Provider and storage adapters never know where credentials are stored.
