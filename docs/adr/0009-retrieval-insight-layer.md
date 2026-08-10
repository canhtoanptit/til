# ADR-0009: Retrieval & insight layer — Workers AI embeddings + Vectorize + D1 FTS5

- **Status:** Accepted (measured 2026-08-10; fusion fixed and re-measured same day — see the P17/P17.1 notes at the end)
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

## Measured (P17 baseline, 2026-08-10 — bge-m3, 50-entry fixture corpus, 41 gold queries; `packages/evals/history/`)

The open question — _does hybrid beat FTS-only?_ — is answered **yes, but it's the wrong question**: nDCG@8 overall was FTS 0.593, **hybrid 0.674**, **vector-only 0.816**. Hybrid beat FTS everywhere (9.5× on the semantic slice) yet lost to plain vector search **on every slice**, because the fusion degrades the semantic leg: (a) `sanitizeFtsQuery` ORs every token including stopwords, so the keyword leg never abstains and always supplies a full pool of confidently-wrong candidates (top-1 wrong 16/16 on semantic queries); (b) RRF gives equal scores to equal ranks and `rrfMerge` breaks ties **alphabetically by entry id**, interleaving junk ahead of correct vector hits. Reproduced independently on the owner's real data. Sweeps confirmed RRF `k` is not the lever (best config k=20/pool 4× still only reached 0.721). Fix queued as **P17.1**: an abstaining keyword leg (stopword filtering, empty → no candidates), leg weighting, a principled tiebreak, the hybrid fusion lifted into `@til/core` so app and evals share one implementation — every change measured against this baseline. Also noted: the keyword slice scored 1.000 in all modes, i.e. it doesn't yet discriminate; identifier-style cases (error codes, CVEs) are needed to guard the abstain policy.

## Fixed and re-measured (P17.1, 2026-08-10 — 55-entry corpus after adding 5 identifier cases, 46 gold)

Shipped fusion (`fuseHybrid` in `@til/core`, defaults `k=20`, weights 0.7/0.3, semantic tiebreak, **selective keyword vote**): **hybrid 0.828 nDCG@8 ≥ vector-only 0.806**, with semantic parity (0.530), keyword 1.000 vs vector's 0.950, mixed parity — hybrid is no longer worse than its best leg on any slice. The decisive mechanism was not in the original fix list: the keyword leg was voting at full strength even when its hit set showed it had located a _topic_ (4–22 hits) rather than pinned a _document_ (≤3 hits); down-weighting non-selective keyword votes so they provably cannot displace the semantic top hit is what closed the gap (briefed policies alone peaked at 0.794). `sanitizeFtsQuery` now stopword-filters per unicode61 token and abstains entirely on empty queries; ties can never be decided by entry id. Honest caveats recorded in the eval history: the hybrid-over-vector margin rests on identifiers that live only in `contentMarkdown` (FTS-indexed but not embedded — a real production property); two semantic gold cases remain unreachable by any mode (embedder recall ceiling); chat-eval baselines will shift since the chat search tool shares this path.
