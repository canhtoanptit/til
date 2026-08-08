# ADR-0010: Dual-mode stack — `TIL_STACK=local | cloud`

- **Status:** Accepted
- **Date:** 2026-08-04
- **Related:** [ADR-0009](./0009-retrieval-insight-layer.md), [ADR-0006](./0006-content-extraction-to-markdown.md), [ADR-0005](./0005-byok-llmclient-abstraction.md)

## Context

Two capabilities in the design have **no local emulator**: **Workers AI** ("always runs remotely and incurs usage charges even in local dev") and **Vectorize** (expects `remote: true`). Everything else — Worker, D1, FTS5, Workflows, cron, Durable Objects — emulates fully offline. Since the AI and Vectorize bindings were commented out at P0, local runs have been silently degraded: extraction fell back to a crude regex stripper and embeddings were skipped entirely.

M3 makes that untenable: the chat agent's whole point is semantic retrieval, which needs real vectors. The owner's constraint is to build the full flow locally and deploy once at the end, without buying hardware or juggling API tokens.

An earlier framing treated this as three independent choices (extractor, embedder, vector store). That yields 8 combinations, most untested and some incoherent.

## Decision

One environment variable selects a **coherent set of adapters**:

|              | `TIL_STACK=local`                    | `TIL_STACK=cloud`             |
| ------------ | ------------------------------------ | ----------------------------- |
| Extractor    | Readability + Turndown (in-isolate)  | `env.AI.toMarkdown()`         |
| Embedder     | Ollama `bge-m3` via `/api/embed`     | Workers AI `@cf/baai/bge-m3`  |
| Vector store | `D1VectorStore` (brute-force cosine) | Vectorize index `til-entries` |

- **The mode selects adapters, not where the Worker runs.** These are independent, giving three supported configurations: local dev + `local` (offline daily driver), local dev + `cloud` (pre-deploy parity check; needs `CLOUDFLARE_API_TOKEN` and the bindings uncommented), deployed + `cloud` (production). Deployed + `local` is unsupported — there is no Ollama at the edge.
- **The same embedding model in both modes.** BAAI bge-m3, 1024-d, is available both as a Workers AI model and an Ollama pull, so the vector space is identical and local ranking behaviour is representative of production. Vectors are not bit-identical (GGUF quantization differs), which is acceptable for search; re-embed if exactness ever matters.
- **`Embedder` implementations MUST return L2-normalized (unit-length) vectors.** Ollama's `/api/embed` already does; other adapters normalize explicitly. This makes cosine similarity a dot product in `D1VectorStore` and keeps every mode consistent with Vectorize's cosine metric.
- Vector metadata records `embedModel` and dimensions; writes validate the dimension against the index.
- The BYOK chat/digest provider (Groq/OpenAI/Anthropic) is **not** part of the mode — it stays runtime `settings` in D1 ([ADR-0005](./0005-byok-llmclient-abstraction.md)). Infrastructure and provider choice are orthogonal.

## Alternatives considered

- **Per-capability toggles** (`TIL_EXTRACTOR`, `TIL_EMBEDDER`, `TIL_VECTORS`). Maximum flexibility, 8 combinations, most never exercised. Rejected: the flexibility is theoretical and the test matrix is not.
- **Cloud-only, with remote bindings in dev.** Perfect parity and zero local resources, but every dev session needs a Cloudflare API token and burns free-tier neurons, and the app stops working on a plane. Kept as the _parity-check_ configuration rather than the default.
- **Stub embedder locally** (hash-based vectors). Free and instant, but rankings are meaningless, so hybrid search cannot be evaluated until after deploy — which defeats building M3 locally at all.
- **Qdrant in Docker for local vectors.** Closest API parity with Vectorize, but adds a daemon plus Docker Desktop overhead to search ~10³ vectors that a `for` loop handles in milliseconds. Rejected as disproportionate.
- **sqlite-vec in D1.** The natural fit on paper; D1/workerd cannot load SQLite extensions. Usable only in `better-sqlite3` unit tests.

## Consequences

**Positive**

- The entire product — including M3 retrieval — is buildable and testable offline, with real semantic quality, no cloud resources and no API token.
- Two coherent configurations to test instead of eight; the mode boundary matches the deploy boundary.
- Local extraction improves from regex-stripping to genuine reader-view, and Readability doubles as a production fallback for pages `toMarkdown` mishandles ([ADR-0006](./0006-content-extraction-to-markdown.md)).

**Negative / caveats**

- **Extraction is not identical across modes** — Readability and `toMarkdown` produce different markdown, so digest text (and therefore digest quality) differs. "Works locally" does not prove production quality; the parity configuration exists for that.
- Local mode requires Ollama running (~1.2 GB model, ~2 GB RAM). Embedding failure stays non-fatal — entries still reach `ready`, just unindexed — so the failure mode is a silent search gap; it must be surfaced in the UI.
- Two vector-store implementations to keep behaviourally equivalent; `D1VectorStore` is O(n) per query and is explicitly a dev/small-corpus tool, not a scaling path.
- Switching modes on an existing local database leaves vectors from the other embedder in place. Same model means they remain comparable; a re-embed command is the clean remedy.
