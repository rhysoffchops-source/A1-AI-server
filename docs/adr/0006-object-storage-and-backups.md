# ADR 0006: Object storage and backups

- Status: Accepted
- Date: 2026-07-28

## Decision

A1 uses one object-storage port for local disk and S3-compatible services. Local writes use
same-filesystem temporary files and atomic rename. S3 configuration supplies region, endpoint,
bucket, addressing mode, and secret references, which covers AWS S3, Backblaze B2, Cloudflare R2,
and compatible services.

Backups contain immutable objects followed by a completion manifest. Every object carries an
independent SHA-256 digest and byte length. Restore verifies the entire object before publishing it
through an atomic restore target.

## Consequences

- Storage backends can change without changing callers.
- An incomplete backup has no manifest and is never considered restorable.
- Live databases must expose a consistent snapshot source rather than copying mutable files.
