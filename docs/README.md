# TIL — Design Docs

Design documentation for **TIL** ("Today I Learned"): a cross-platform, single-user app where you paste a link and an LLM extracts the content and surfaces the most interesting takeaway, building a searchable feed of what you've learned — plus a periodic "interesting things" digest and a chat agent that answers questions about your learning.

These docs exist to be **reviewed and agreed before implementation**. Nothing here is built yet.

## Status: Proposed (under review)

## How to read these

Start with the **[Technical Design (TDR)](./tech-design.md)** for the full picture, then read the **ADRs** for the reasoning behind each load-bearing choice. Each ADR is standalone and uses the format *Status · Context · Decision · Alternatives considered · Consequences*.

## Index

| Doc | What it covers |
|-----|----------------|
| [tech-design.md](./tech-design.md) | Problem, goals/non-goals, architecture, data model, API, ingest pipeline, milestones, verification, risks |
| [adr/0001](./adr/0001-cross-platform-web-first-tauri2.md) | Cross-platform strategy: web-first + Tauri 2 |
| [adr/0002](./adr/0002-ai-stack-pi-cloudflare-ai-gateway.md) | AI stack: Pi + Cloudflare AI Gateway (BYOK) |
| [adr/0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md) | Runtime & deploy: Cloudflare Workers + `@cloudflare/vite-plugin` |
| [adr/0004](./adr/0004-database-d1-drizzle.md) | Database: Cloudflare D1 + Drizzle |
| [adr/0005](./adr/0005-byok-llmclient-abstraction-nodejs-compat.md) | BYOK access via `LLMClient` abstraction + `nodejs_compat` |
| [adr/0006](./adr/0006-content-extraction-to-markdown.md) | Content extraction: `env.AI.toMarkdown()` + Browser Rendering fallback |
| [adr/0007](./adr/0007-single-user-local-first.md) | Single-user, local-first, BYOK key at rest |
| [adr/0008](./adr/0008-monorepo-pnpm-turborepo.md) | Repository: pnpm workspaces + Turborepo |

## Decision summary

| # | Decision | Chosen | Rejected alternatives |
|---|----------|--------|-----------------------|
| 1 | Cross-platform | Web-first React+Vite, wrapped by Tauri 2 | Expo/React Native; Flutter |
| 2 | AI stack | Pi (`pi-ai` + `pi-agent-core`) via Cloudflare AI Gateway | CF Agents SDK; Pi-only |
| 3 | Runtime/deploy | Cloudflare Workers + `@cloudflare/vite-plugin` (one full-stack Worker) | Pages + separate Worker |
| 4 | Database | Cloudflare D1 (SQLite) + Drizzle | Postgres; raw SQL |
| 5 | BYOK access | `LLMClient` interface; Pi behind it + `nodejs_compat`; direct-fetch fallback | Bind directly to Pi everywhere |
| 6 | Extraction | `env.AI.toMarkdown()` default; Browser Rendering fallback | Readability + linkedom in-isolate |
| 7 | Users | Single-user, local-first; BYOK key in own D1 | Multi-user SaaS + auth from day 1 |
| 8 | Repo | pnpm workspaces + Turborepo | Single package; Nx |

## Prerequisites (for when we implement)

- A Cloudflare account (D1 + AI Gateway + deploy)
- One provider API key: OpenAI **or** Anthropic (BYOK)
- Node ≥ 20 and pnpm

## Milestones (see TDR for detail)

- **M1** — Web thin slice: paste link → extract → BYOK LLM digest via AI Gateway → D1 → feed + detail + settings.
- **M2** — "Interesting things" digest agent (modeled on `mvanhorn/last30days-skill`).
- **M3** — Chat agent (`pi-agent-core` + `pi-web-ui`) over your D1.
- **M4** — Desktop + mobile via Tauri 2.
- **M5** — (optional) multi-user, richer extraction, spaced-repetition review.
