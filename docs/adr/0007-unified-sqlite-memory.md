# ADR 0007: Unified SQLite memory

- Status: Accepted
- Date: 2026-07-28

## Decision

The initial memory adapter persists conversations, scoped memories, embedding vectors, and graph
relations in one SQLite database. Full-text search uses FTS5; vector ranking uses cosine similarity
over validated finite vectors. Project, agent, semantic, and global memory differ by scope metadata,
not separate storage implementations.

## Consequences

- Every memory type survives restart and can participate in one backup.
- Small and medium local installations require no external vector database.
- The `MemoryEngine` contract permits future dedicated vector and graph adapters.
