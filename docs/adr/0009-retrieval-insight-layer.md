# ADR-0009: Retrieval & insight layer — Workers AI embeddings + Vectorize + D1 FTS5

- **Status:** Accepted
- **Date:** 2026-08-02
- **Related:** [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [ADR-0004](./0004-database-d1-drizzle.md)

## Context

The problem statement promises a **searchable feed** and a chat agent that answers questions **grounded in TIL history** with insights and recommendations (M3). The v1 data model had no index of any kind. Three distinct access patterns must be served, and only one of them is RAG:

| Query type      | Example                                              | Mechanism                              |
| --------------- | ---------------------------------------------------- | -------------------------------------- |
| Semantic        | "what have I learned about consensus algorithms?"    | Vector similarity                      |
| Keyword / exact | "that arxiv paper on speculative decoding"           | Full-text search (BM25-ish)            |
| Analytical      | "what did I learn most this month? am I consistent?" | SQL aggregation — not retrieval at all |

Constraints: corpus is small (~10³ short entries); everything runs in one Worker; **Anthropic has no embeddings API**, so a BYOK-Anthropic user breaks any "use the provider for everything" plan; Vectorize caps vectors at 1536 dimensions.

## Decision

Build the layer from Cloudflare-native pieces, populated **at ingest time from M1** (backfill = full reprocess, so start now even though search UI is minimal in M1):

1. **Embeddings: Workers AI `@cf/baai/bge-m3`** (1024-dim, keyless, effectively free at this scale) — provider-independent, so it works identically for OpenAI and Anthropic BYOK users.
2. **Vector index: Vectorize** — index `til-entries`, cosine metric, one vector per entry (id = entry id) over `title + takeaway + summary + tags`; metadata `{ domain, createdAt }` for filtered queries. Upsert when an entry becomes `ready`; delete/re-upsert on delete/reingest. Content-chunk vectors are a later option if digest-level recall proves insufficient.
3. **Keyword index: D1 FTS5** external-content virtual table (`entries_fts`) over title/summary/takeaway/tags/content, kept in sync by SQLite triggers. Serves `GET /api/search` in M1.
4. **Hybrid retrieval (M3):** the chat agent's `search_entries` tool queries Vectorize (topK) and FTS5, merges with reciprocal-rank fusion.
5. **Insight tools (M3):** predefined SQL aggregations (entries/week, tag distribution, top domains, streaks) exposed as agent tools — insights are mostly `GROUP BY` + generation, not RAG.

## Alternatives considered

- **Cloudflare AI Search (ex-AutoRAG).** Managed chunk/embed/index over stored objects, hybrid vector+BM25 built in, free beta. Rejected for now: beta with recent architecture migration, retrieval keys to stored objects rather than D1 rows (awkward joins back to entry metadata), and it removes the layer this project exists to learn to build. Revisit if the DIY layer becomes a chore.
- **Provider embeddings (OpenAI `text-embedding-3-*`).** Fine for OpenAI users, impossible for Anthropic-only BYOK; adds per-call cost and a provider coupling for zero quality benefit at this corpus size. (`3-large` at 3072 dims also exceeds Vectorize's cap.)
- **No vector index — FTS5/`LIKE` only.** Simplest, and honestly adequate for keyword recall at this scale, but fails the semantic queries M3 is for; embedding at ingest is one cheap call per entry.
- **Brute-force cosine in D1 (no Vectorize).** Viable at ~10³ vectors but reads every row per query and hand-rolls what Vectorize gives free; not worth the cleverness.
- **Mastra RAG / LlamaIndex.TS.** Framework-managed retrieval — rejected per [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md) reasoning (hides the learning layer).

## Consequences

**Positive**

- Retrieval-ready index from day one; all pieces free-tier at this scale; no new accounts or keys.
- Embeddings decoupled from the BYOK provider — provider switches never invalidate the index.
- The hybrid search + insight tools are exactly the "AI system engineering" the project is for.

**Negative / caveats**

- Two indexes to keep consistent with D1 (Vectorize upsert/delete on status transitions; FTS via triggers). Consistency is eventual by a few seconds — acceptable for one user.
- Changing the embedding model later means re-embedding everything — record the model name per vector (metadata) from the start.
- FTS5 virtual tables and triggers are hand-written migrations (drizzle-kit cannot generate them).
- Vectorize is Cloudflare-locked; exit path is trivial at this scale (re-embed into pgvector/libSQL) but nonzero.
