# TIL — Design Docs

Design documentation for **TIL** ("Today I Learned"): a cross-platform, single-user app where you paste a link and an LLM extracts the content and surfaces the most interesting takeaway, building a searchable feed of what you've learned — plus a periodic "interesting things" digest and a chat agent that answers questions about your learning.

## Status: Accepted — implementation planned, nothing built yet

Reviewed 2026-08-02. The AI stack was revised during review (Pi → Vercel AI SDK), a retrieval & insight layer and an auth requirement were added. Implementation proceeds phase-by-phase per the **[implementation plan](./implementation-plan.md)**.

## How to read these

Start with the **[Technical Design (TDR)](./tech-design.md)** for the full picture, then the **ADRs** for the reasoning behind each load-bearing choice (format: _Status · Context · Decision · Alternatives considered · Consequences_). The **[implementation plan](./implementation-plan.md)** turns the design into frozen contracts + self-contained agent briefs.

## Index

| Doc                                                                    | What it covers                                                                                            |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| [tech-design.md](./tech-design.md)                                     | Problem, goals/non-goals, architecture, data model, API, ingest pipeline, milestones, verification, risks |
| [implementation-plan.md](./implementation-plan.md)                     | Frozen contracts, phase breakdown, independent agent briefs, orchestration rules                          |
| [adr/0001](./adr/0001-cross-platform-web-first-tauri2.md)              | Cross-platform strategy: web-first + Tauri 2                                                              |
| [adr/0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md) | AI stack: Vercel AI SDK + Cloudflare AI Gateway (BYOK) — supersedes Pi                                    |
| [adr/0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)       | Runtime & deploy: Cloudflare Workers + `@cloudflare/vite-plugin`                                          |
| [adr/0004](./adr/0004-database-d1-drizzle.md)                          | Database: Cloudflare D1 + Drizzle                                                                         |
| [adr/0005](./adr/0005-byok-llmclient-abstraction.md)                   | BYOK access via `LLMClient` abstraction (AI SDK primary, hand-rolled fallback)                            |
| [adr/0006](./adr/0006-content-extraction-to-markdown.md)               | Content extraction: `env.AI.toMarkdown()` behind an `Extractor` seam                                      |
| [adr/0007](./adr/0007-single-user-local-first.md)                      | Single-tenant self-hosted; auth before deploy; BYOK key at rest                                           |
| [adr/0008](./adr/0008-monorepo-pnpm-turborepo.md)                      | Repository: pnpm workspaces + Turborepo                                                                   |
| [adr/0009](./adr/0009-retrieval-insight-layer.md)                      | Retrieval & insight: Workers AI embeddings + Vectorize + D1 FTS5                                          |
| [adr/0010](./adr/0010-dual-mode-local-cloud-stack.md)                  | Dual-mode stack: `TIL_STACK=local` (Readability + Ollama + D1 cosine) vs `cloud`                          |

## Decision summary

| #   | Decision            | Chosen                                                                             | Rejected alternatives                                                 |
| --- | ------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Cross-platform      | Web-first React+Vite, wrapped by Tauri 2 (PWA pass first)                          | Expo/React Native; Flutter                                            |
| 2   | AI stack            | Vercel AI SDK v6 via Cloudflare AI Gateway; M2 = Workflows, M3 = Agents SDK        | Pi (superseded); Mastra; LangChain.js/LlamaIndex.TS; direct SDKs only |
| 3   | Runtime/deploy      | Cloudflare Workers + `@cloudflare/vite-plugin` (one full-stack Worker)             | Pages + separate Worker                                               |
| 4   | Database            | Cloudflare D1 (SQLite) + Drizzle                                                   | Postgres; raw SQL                                                     |
| 5   | BYOK access         | `LLMClient` seam; `AISDKClient` primary + hand-written `DirectLLMClient` fallback  | Bind directly to the SDK everywhere; fallback-only                    |
| 6   | Extraction          | `env.AI.toMarkdown()` behind an `Extractor` seam; Browser Rendering fallback       | Readability + linkedom in-isolate; external APIs                      |
| 7   | Users & auth        | Single-tenant self-hosted; bearer `APP_TOKEN` mandatory before deploy              | Multi-user SaaS from day 1; no-auth-when-deployed                     |
| 8   | Repo                | pnpm workspaces + Turborepo                                                        | Single package; Nx                                                    |
| 9   | Retrieval & insight | Workers AI `bge-m3` + Vectorize + D1 FTS5, embed at ingest; insights via SQL tools | AI Search (managed); provider embeddings; FTS-only                    |

## Prerequisites (for when we deploy)

- A Cloudflare account (D1 + Vectorize + AI Gateway + Workers AI + deploy)
- One provider API key: OpenAI **or** Anthropic (BYOK)
- Node ≥ 20 and pnpm

## Milestones (see TDR §12 for detail)

- **M1** — Web thin slice: paste link → extract → BYOK LLM digest via AI Gateway → D1 + Vectorize + FTS → feed + search + detail + settings.
- **M1.5** — Deploy hardening: token auth live, real CF resources, backup export.
- **M2** — "Interesting things" digest: Cloudflare Workflow + cron (the `last30days` pattern, Worker-native).
- **M3** — Chat agent: Agents SDK + hybrid retrieval + SQL insight tools; AI Elements/assistant-ui.
- **M4** — Desktop + mobile: PWA, then Tauri 2.
- **M5** — (optional) multi-user, richer extraction, spaced-repetition review.
