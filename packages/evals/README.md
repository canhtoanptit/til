# @til/evals

The measurement layer for TIL's retrieval and chat behaviour (ADR-0011, stage v1:
deterministic checks only, no LLM judge). Nothing here runs as part of `pnpm test`
except its own network-free unit tests — the eval runs cost neurons and are
invoked explicitly.

## What it measures

**Retrieval** (`pnpm --filter @til/evals eval:retrieval`)

Seeds `fixtures/corpus.json` into an in-memory SQLite database built from the real
`packages/db` migrations, so FTS5 and its triggers behave exactly as in
production, embeds every entry with `WorkersAIRestEmbedder` (`@cf/baai/bge-m3`,
1024-d), and runs `datasets/retrieval-gold.json` three ways:

| mode | legs |
| --- | --- |
| `fts` | FTS5 `MATCH` ordered by bm25 |
| `vector` | cosine over the stored vectors |
| `hybrid` | both, fused with `rrfMerge` |

Metrics per case: recall@3, recall@topK, reciprocal rank, nDCG@topK — binary
gains, `1/log2(rank+1)` discount, ideal = `min(|gold|, k)` (see `src/metrics.ts`).
Aggregated overall and per `kind`, then swept over RRF `k ∈ {20, 60, 120}` and
pool multiplier `∈ {2, 3, 4}`. Every run appends a line to
`history/eval-history.jsonl` with the git SHA and the config, so two runs are
always comparable.

**Chat** (`pnpm --filter @til/evals eval:chat`) — see the live gate below.

Drives `datasets/chat-scenarios.json` and `datasets/injection-suite.json` through
`streamChat` with the real system prompt and the real tool schemas from
`@til/core`, over the same fixture database, and checks four things
deterministically:

- the expected tool was called that conversation (or none was)
- **citation precision**: every url in the answer came from a tool result
- **refusal**: cases with nothing to find cite zero urls
- **injection**: a canary planted in retrieved text never reaches the answer

## Setup

The retrieval suite needs a real embedder — without one only the keyword leg
exists, and silently measuring half of a hybrid system is worse than failing. It
reads, in order, the environment then `apps/web/.dev.vars`:

```
CF_ACCOUNT_ID=<Cloudflare account id>
WORKERS_AI_API_TOKEN=<API token with the "Workers AI - Read" permission>
```

Corpus and query embeddings are cached on disk in `fixtures/.cache/` (gitignored),
keyed by model, dimensions and a hash of the text, so a re-run after editing one
entry costs one REST call rather than fifty. Delete the directory to force a
re-embed.

## Running the chat suite live

Live provider calls are opt-in, because they cost the owner's key and because a
model whose tool calling the provider rejects measures nothing (see
`describeChatStreamError` — Groq's `llama-3.3-70b-versatile` is the known case).
`eval:chat` explains itself and exits without calling anything unless all of
these are set:

```
EVAL_LIVE=1
EVAL_PROVIDER=openai|anthropic|groq
EVAL_MODEL=<a model whose tool calling the provider accepts>
EVAL_API_KEY=<provider key>
EVAL_CF_ACCOUNT_ID=<AI Gateway account id>
EVAL_CF_GATEWAY_ID=<AI Gateway id>
```

Cost: roughly `(scenarios + injection cases) × 2` provider calls — about 60 for
the current datasets — plus one Workers AI embedding call per distinct search
query the model issues.

## Golden-set discipline

The datasets are code: they change in the same phase that changes behaviour, and
`src/datasets.test.ts` enforces the properties that make them meaningful. The
load-bearing one: **a `semantic` case must share no content word with its
target's FTS-indexed text.** If it does, the keyword leg can find it too and the
case stops measuring the semantic leg — so that test fails the build rather than
quietly flattering hybrid search. `keyword` cases are required to contain a term
that appears in at most three entries, and injection canaries must appear in
their seed entry and nowhere in the clean corpus.

## Layout

```
fixtures/corpus.json          50 entries; near-duplicate pairs and keyword traps
                              ("cold start", "partition", "token", "index", ...)
datasets/retrieval-gold.json  41 cases: 16 semantic, 15 keyword, 10 mixed
datasets/chat-scenarios.json  20 conversations with expected tool / refusal
datasets/injection-suite.json 10 hostile entries, one canary each
history/eval-history.jsonl    append-only run log (committed; carries no secrets)
src/metrics.ts                recall@k, MRR, nDCG@k, citation precision
src/runner.ts                 fixture stack: migrations + seed + vectors
src/retrieval.ts              the three modes, parameterised by k and pool
src/run-retrieval.ts          the retrieval suite entry point
src/run-chat.ts               the chat suite entry point and its checks
src/report.ts                 console tables and the history log
```

## Known copies

Two pieces are duplicated from `apps/web` rather than imported, because the app
is a Worker entrypoint with no package exports and this package deliberately does
not depend on it: `sanitizeFtsQuery` (in `src/retrieval.ts`) and the
`D1VectorStore` scoring loop (`SqliteVectorStore` in `src/runner.ts`). Both are
marked in place. If either changes in the app, change it here too — or better,
move the hybrid search function into `@til/core` so there is only one.
