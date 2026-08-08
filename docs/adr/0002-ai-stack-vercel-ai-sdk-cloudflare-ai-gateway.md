# ADR-0002: AI stack — Vercel AI SDK via Cloudflare AI Gateway (BYOK)

- **Status:** Accepted (v2, 2026-08-02)
- **Date:** 2026-08-02
- **Related:** [ADR-0005](./0005-byok-llmclient-abstraction.md), [ADR-0009](./0009-retrieval-insight-layer.md), [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md)
- **History:** v1 chose Pi (`pi-ai` + `pi-agent-core` + `pi-web-ui`). Superseded in-place after review — see _Why the reversal_ below.

## Context

TIL is an ingest → extract → **index** → serve system. The AI layer must cover six capabilities:

1. Multi-provider model access with the user's own key (BYOK), routed through a gateway we control.
2. Structured extraction (schema-validated digest) — M1.
3. Embeddings — generated at ingest (M1) to power retrieval later.
4. Retrieval & insight over TIL history (semantic + keyword + SQL analytics) — M3, enables M2.
5. Agent serving: streaming chat, session state, tool loop — M3.
6. Chat UI — M3.

### Why the reversal from Pi

Review (2026-08-02, verified against `earendil-works/pi`):

- Pi consolidated into a **coding-agent/terminal toolkit** (`pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`). **`pi-web-ui` no longer ships**, and Pi has **no embeddings, RAG, retrieval, or memory layer** — it covers ~2 of the 6 capabilities above.
- `pi-ai` is Node-first (`node:fs` barrel import, AWS SDK transitively) → required `nodejs_compat` + bundle weight on Workers.
- Project health is fine (62k stars, company-backed at `@earendil-works`); the problem is **scope mismatch**, not maintenance risk.

## Decision

Use the **Vercel AI SDK** (`ai` v6, exact-pinned) as the model-access and orchestration layer, with all LLM calls routed through **Cloudflare AI Gateway** using the user's BYOK key. Split the six capabilities across purpose-fit tools:

| Capability          | Choice                                                                                                                                    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Model access (BYOK) | AI SDK provider packages (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/groq` — Groq added post-P5 as the free-tier option), instantiated per request from `settings`, `baseURL` → CF AI Gateway |
| Structured digest   | AI SDK structured output (v6 Output API; `generateObject` is deprecated)                                                                  |
| Embeddings          | **Not** via the BYOK provider (Anthropic has no embeddings API) — Workers AI, see [ADR-0009](./0009-retrieval-insight-layer.md)           |
| Retrieval & insight | Vectorize + D1 FTS5 + SQL tools, see [ADR-0009](./0009-retrieval-insight-layer.md)                                                        |
| M2 digest pipeline  | Cloudflare **Workflows** (durable steps) + AI SDK calls — it is a pipeline, not an autonomous agent                                       |
| M3 chat serving     | Cloudflare **Agents SDK** (`AIChatAgent` on Durable Objects: WebSocket streaming, message persistence, resumable streams) + AI SDK inside |
| Chat UI             | AI Elements or assistant-ui (React) — replaces the defunct `pi-web-ui` plan                                                               |

### Guardrails (binding)

1. **Explicit provider instances only.** Plain string model IDs (`model: 'openai/gpt-…'`) silently route through **Vercel's paid AI Gateway** (Vercel account + credits billing). Banned — every call uses `createOpenAI(...)` / `createAnthropic(...)` with our CF gateway `baseURL`. Greppable rule in code review.
2. **Pin the major** (`ai@6.x`, exact in lockfile). Budget ~one deliberate migration per major (~yearly cadence; v7 already announced — evaluate after M1).
3. The `ai` package is imported **only inside `packages/core`** behind the `LLMClient` seam ([ADR-0005](./0005-byok-llmclient-abstraction.md)) — the exit hatch if the SDK's churn ever outweighs its value.

## Alternatives considered

- **Pi** (v1 decision). Rejected: covers 2/6 capabilities; no web UI, embeddings, or retrieval; Workers friction. `pi-agent-core`'s small readable loop is kept as **reference reading** for the hand-rolled M3 loop.
- **Mastra.** Only alternative covering all six slots (agents, memory, RAG, workflows, CF deployer; wraps AI SDK underneath). Rejected: preassembles exactly the components (retrieval, memory, loop policy) this project exists to learn by building; imposes its own server/storage model over our Hono+D1 design.
- **LangChain.js / LlamaIndex.TS.** Heavy abstractions, TS ports lag, Workers compat friction; multi-index machinery is overkill for ~10³ short documents.
- **Direct provider SDKs only.** Workers-clean, but hand-rolls the provider switch (the unified layer's whole job) and juggles two structured-output dialects. Survives as the hand-written `DirectLLMClient` fallback ([ADR-0005](./0005-byok-llmclient-abstraction.md)).
- **Cloudflare Agents SDK as the whole AI layer.** It is a serving/state layer, not a model-access layer. Adopted _selectively_ for M3 chat serving, not as the stack.

## Consequences

**Positive**

- Edge-native (fetch-based): the AI SDK itself needs no `nodejs_compat`, deleting ADR-0005 v1's compat/bundle problem class. (The flag was later re-enabled at M3 for the **Agents SDK**, not for the AI SDK — see [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md).)
- Schema-validated structured output; `embed`/`embedMany`; tool loop; `useChat`; largest TS AI ecosystem; provider boundary is a published spec with independent co-maintainers (Cloudflare, OpenRouter ship their own providers).
- Apache-2.0 library, no service dependency on Vercel when guardrail 1 is followed; worst case is pin-and-fork.

**Negative / caveats**

- Major-version churn is the real tax (v4→v5→v6→v7; `generateObject` deprecation). Mitigated by pinning + the seam.
- The zero-config path funnels to Vercel's paid gateway — requires the standing guardrail, forever.
- Framework idioms (tool defs, UIMessage stream protocol) are moderate lock-in; exit cost is hours for M1/M2 (behind the seam), days for M3 chat.
