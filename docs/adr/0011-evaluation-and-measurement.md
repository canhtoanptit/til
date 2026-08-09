# ADR-0011: Evaluation & measurement — staged: hand-rolled deterministic core, promptfoo for the judged layer

- **Status:** Accepted (staged v1/v2 after owner discussion, 2026-08-09)
- **Date:** 2026-08-08
- **Related:** [ADR-0009](./0009-retrieval-insight-layer.md), [ADR-0010](./0010-dual-mode-local-cloud-stack.md), [ADR-0005](./0005-byok-llmclient-abstraction.md)

## Context

M1–M3 shipped a full RAG system: hybrid retrieval (vector + FTS5 via RRF), a digest pipeline, and a tool-calling chat agent. Every quality-affecting decision so far was made by judgment, not measurement: the RRF `k`, the `topK*2` pool multiplier, the embedding-text composition, prompt caps, the Groq model switch after the tool-calling failure, and ADR-0009's own open question — _does hybrid actually beat FTS-only at this corpus size?_ — is still a belief, not a number.

The project's stated purpose is learning AI-system engineering; evaluation is the half of that discipline not yet built. Constraints: single user (no traffic to A/B), BYOK (eval LLM calls cost the owner's key), TypeScript everywhere, and the dual-mode stack means a full retrieval stack runs offline (Ollama bge-m3 + D1 cosine + real migrations over better-sqlite3).

## Decision

**Stage the eval layer in two deliberately different builds**, in a new workspace package `@til/evals` that is _not_ wired into the `turbo test` pipeline (evals are non-deterministic and cost money; tests must stay free and green):

- **v1 (P17) — hand-rolled deterministic core, zero LLM cost.** Retrieval metrics and ablations, citation precision, tool-selection accuracy, refusal checks, injection canaries. Hand-rolled because this is the layer existing tools are weakest at (classic IR metrics and parameter sweeps over _our_ hybrid function end up custom code inside any framework) and the layer with the highest learning value per line (~400–500 LOC plus reviewed data, riding the existing test-harness seams).
- **v2 (when a judge is actually needed — expected at the personalized-ranking phase) — adopt promptfoo as the runner for the judged layer**: faithfulness/answer-relevance rubrics, model matrices (e.g. Groq `gpt-oss-20b` vs `120b` on our tasks), and red-team attack packs, via a custom JS provider wrapping `streamChat` + the fixture DB (chat is WebSocket-only in the app, so the seam — not the HTTP surface — is the integration point). Rationale: judge prompts and attack generation are where hand-rolled evals go quietly wrong and where a maintained tool compounds; the custom-provider glue is code we need anyway; and hands-on time with the tools the market actually uses is itself part of this project's learning goal.
- **Langfuse (or any tracing platform) is explicitly deferred to a post-deploy decision**, with "AI Gateway logs suffice for one user" as the default position.

Principles, in priority order:

1. **Deterministic before LLM-judge.** The v1 metrics are pure computation — free, repeatable, CI-able. LLM-as-judge is reserved for what only a judge can score, and arrives only with v2. Until then, transcript-reading remains the primary quality instrument — every real failure so far was found by looking, not by a metric; metrics encode the failure taxonomy that looking builds.
2. **Golden sets live in the repo** as reviewed JSON (retrieval gold, chat scenarios, injection suite) over a seeded fixture corpus, bootstrapped by an LLM and verified by hand once. The per-entry `question` field doubles as a natural eval query source.
3. **Judge ≠ generator.** The judging model must differ from the model under test (larger, or at least a different model on the same gateway); rubric-based 3-point scales, never 1–10.
4. **Every run is comparable.** Results append to a history log with git SHA + config snapshot (model, RRF k, topK, embedder); phases that touch retrieval or prompts record before/after numbers in the plan changelog.
5. **Online signals come later and stay small**: a `feedback` table (👍/👎 on chat answers), click-through on cited entries, and AI Gateway logs for latency/token cost (already free — the reason everything routes through the gateway).

## Alternatives considered

- **promptfoo for everything, including retrieval.** Rejected for v1: the IR metrics and ablation sweeps become custom JS asserts inside YAML — hand-rolling with extra indirection — and it hides the loop (dataset → run → score → report) v1 exists to teach. Adopted deliberately for the v2 judged layer, where its strengths (maintained rubrics, model matrices, red-team packs, result viewer) are real and the DIY equivalent is where errors hide.
- **Hand-rolling the judge layer too** (the original v1 of this ADR). Rejected after discussion: judge-prompt quality is the most error-prone part of DIY evals, the conveniences (matrices, caching, attack generation) are genuinely valuable, and experience with the tools named in AI-engineering job descriptions is part of the project's learning goal, not a compromise of it.
- **Evalite** (vitest-based TS evals). Closest to our stack and pleasant; same v1 learning objection, and for v2 promptfoo's red-team/matrix features win.
- **Ragas / DeepEval.** Python — a second toolchain for a TS monorepo, rejected on principle established in ADR-0002.
- **Langfuse / Braintrust** (hosted or self-hosted tracing + eval platforms). A different category — their core value is tracing production traffic; with zero deployed traffic and one user, a platform (Docker self-host or SaaS account) to observe ~tens of turns a week fails the same "no daemon for n=1" test that rejected Qdrant. AI Gateway already covers cost/latency/request logs. Deferred to post-deploy, not rejected forever.
- **"The test suite is enough."** The 546 unit tests prove wiring, not quality — they cannot say whether hybrid search returns _better_ entries or whether answers are faithful.

## Consequences

**Positive**

- Tuning knobs (RRF k, pool multiplier, embedding text, `status='ready'` filtering, model choice) become evidence-based; ADR-0009's hybrid-vs-FTS question gets answered with data.
- Regression protection for prompt/model changes — the Groq model swap would have been a measured decision.
- The deterministic suite runs offline and free (Ollama + fixtures); judge costs are opt-in and bounded by suite size.

**Negative / caveats**

- Golden sets rot as the product evolves; they need the same contract discipline as code (updated in the same phase that changes behaviour).
- LLM-judge scores are noisy and model-dependent; treat trends and deltas as signal, absolute scores as decoration.
- The retrieval suite needs a real embedder — without one only the FTS leg is measurable (fail loud, don't silently measure half the system). Since the owner's machine cannot run Ollama, the suite uses **`WorkersAIRestEmbedder`** (ADR-0010 amendment): exact production parity, needs `CF_ACCOUNT_ID` + `WORKERS_AI_API_TOKEN` in env, and eval runs spend Workers AI neurons (free tier covers it) instead of being fully offline.
- A harness nobody runs measures nothing: running it is a required step in retrieval/prompt-touching phases, recorded in the changelog.
