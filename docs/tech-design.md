# Technical Design — TIL ("Today I Learned")

- **Status:** Accepted (v2, 2026-08-02 — AI stack revised to Vercel AI SDK, retrieval layer and auth added after review)
- **Date:** 2026-08-02
- **Related:** ADRs [0001](./adr/0001-cross-platform-web-first-tauri2.md)–[0009](./adr/0009-retrieval-insight-layer.md) · [Implementation plan](./implementation-plan.md)

---

## 1. Problem statement

Interesting things are read once and lost. I want a low-friction way to **capture what I learn** — usually just a link — and have the system do the work of turning it into something durable and useful: a short summary, the single most interesting takeaway, tags, and a follow-up question worth exploring. Over time this becomes a searchable feed, a periodic digest of interesting things, and something I can _chat with_ about my own learning habits.

Secondary goal: this is a deliberate playground for building a small **AI system** — configurable agents and a bring-your-own-key (BYOK) LLM gateway — deployed on Cloudflare.

## 2. Goals / non-goals

**Goals**

- Paste a URL → automatic content extraction → LLM digest (summary + takeaway + tags + question) → stored and browsable.
- BYOK: I configure the provider (OpenAI/Anthropic) and my own API key in-app; calls routed through a gateway I control.
- Cross-platform: web first, then desktop and mobile from the same codebase.
- Runs on Cloudflare (Workers + D1 + AI Gateway).
- Extensible toward agents: a digest agent and a chat agent.

**Non-goals (for now)**

- Multi-user / accounts / sharing (single-user, single-tenant self-hosted — see [ADR-0007](./adr/0007-single-user-local-first.md)).
- Beating paywalls or scraping bot-protected sites.
- Native (non-webview) mobile UI.
- Real-time collaboration.

## 3. Users & scope

One user (me), running my own instance. BYOK key and all data live in my own Cloudflare D1. No authentication in local dev; a bearer token (`APP_TOKEN`) is **mandatory before any deploy** ([ADR-0007](./adr/0007-single-user-local-first.md)).

## 4. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker ("til")                     │
│                                                                   │
│  React+Vite SPA ──(static assets binding: env.ASSETS)             │
│        │                                                          │
│        │  fetch /api/*  (Authorization: Bearer APP_TOKEN)         │
│        ▼                                                          │
│   Hono API ────────► D1 (SQLite) [entries, settings, entries_fts] │
│        │                                                          │
│        │  ingest() via ctx.waitUntil                              │
│        ├──► fetch(url)            (SSRF-guarded)                  │
│        ├──► Extractor: env.AI.toMarkdown()   (HTML → markdown)    │
│        ├──► LLMClient (AI SDK) ──► CF AI Gateway ──► LLM          │
│        │                            (BYOK: OpenAI/Anthropic)      │
│        └──► env.AI (bge-m3 embed) ──► VECTORIZE (til-entries)     │
└─────────────────────────────────────────────────────────────────┘
        ▲                      M2: Workflows + Cron (digest agent)
        │ same client build    M3: Agents SDK DO (chat)
   Web / Desktop / Mobile (Tauri 2, M4)
```

One full-stack Worker (via `@cloudflare/vite-plugin`) serves the SPA _and_ the API. The LLM is never called directly by the browser — the Worker holds the BYOK key and routes through **Cloudflare AI Gateway** for caching, rate-limiting, and cost/observability. Every `ready` entry is indexed twice at ingest: a digest-level vector in **Vectorize** and a row in the **FTS5** table ([ADR-0009](./adr/0009-retrieval-insight-layer.md)).

## 5. Monorepo layout

```
til/
  apps/
    web/                    # @cloudflare/vite-plugin app = SPA + Worker
      src/client/           # React SPA (UI)
      src/worker/           # Hono API + CF bindings (D1, AI, AI Gateway)
      wrangler.jsonc
      vite.config.ts
  packages/
    core/                   # domain types, ingest pipeline, LLMClient + Extractor interfaces + AI SDK / direct impls
    db/                     # Drizzle schema + migrations for D1 (incl. FTS5)
  docs/                     # these documents
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
```

Rationale for the monorepo split: [ADR-0008](./adr/0008-monorepo-pnpm-turborepo.md). Later: `packages/ui` (shared components incl. the M3 chat UI) and `apps/native` (Tauri).

## 6. Technology choices

| Layer                    | Choice                                                                            | ADR                                                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Frontend                 | React + Vite (web-first), Tailwind, React Router, TanStack Query                  | [0001](./adr/0001-cross-platform-web-first-tauri2.md)                                                                |
| Desktop/mobile (later)   | Tauri 2 wrapping the same build                                                   | [0001](./adr/0001-cross-platform-web-first-tauri2.md)                                                                |
| API                      | Hono on Cloudflare Workers                                                        | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)                                                         |
| Build/deploy             | `@cloudflare/vite-plugin` (single Worker)                                         | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)                                                         |
| Database                 | Cloudflare D1 + Drizzle                                                           | [0004](./adr/0004-database-d1-drizzle.md)                                                                            |
| LLM                      | Vercel AI SDK v6 via Cloudflare AI Gateway, BYOK (explicit providers only)        | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0005](./adr/0005-byok-llmclient-abstraction.md) |
| Retrieval & insight      | Workers AI `bge-m3` + Vectorize + D1 FTS5, embed at ingest                        | [0009](./adr/0009-retrieval-insight-layer.md)                                                                        |
| M2 digest pipeline       | Cloudflare Workflows + Cron Triggers + AI SDK                                     | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)                                                   |
| M3 chat                  | Cloudflare Agents SDK (`AIChatAgent` DO) + AI SDK; UI: AI Elements / assistant-ui | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0009](./adr/0009-retrieval-insight-layer.md)    |
| Extraction               | `env.AI.toMarkdown()` behind `Extractor` seam + Browser Rendering fallback        | [0006](./adr/0006-content-extraction-to-markdown.md)                                                                 |
| Auth (from first deploy) | Bearer `APP_TOKEN` Worker secret + optional CF Access                             | [0007](./adr/0007-single-user-local-first.md)                                                                        |

## 7. Data model (D1)

**`entries`**

| column                      | type        | notes                                   |
| --------------------------- | ----------- | --------------------------------------- |
| `id`                        | text (pk)   | uuid                                    |
| `url`                       | text        | as submitted                            |
| `canonical_url`             | text        | normalized                              |
| `title`                     | text        | from extraction/LLM                     |
| `source_domain`             | text        | e.g. `arxiv.org`                        |
| `content_markdown`          | text        | extracted body                          |
| `summary`                   | text        | LLM                                     |
| `takeaway`                  | text        | LLM — the single most interesting point |
| `question`                  | text        | LLM — a follow-up worth exploring       |
| `tags`                      | text (json) | LLM — string[]                          |
| `status`                    | text        | `pending` \| `ready` \| `failed`        |
| `error`                     | text        | when `failed`                           |
| `created_at` / `updated_at` | integer     | epoch ms                                |

Indexes: **unique on `canonical_url`** (dedupe — resubmitting a URL returns the existing entry), plus `(status)`, `(created_at desc)`.

**`entries_fts`** — FTS5 external-content virtual table over `title, summary, takeaway, tags, content_markdown`, synced by insert/update/delete triggers ([ADR-0009](./adr/0009-retrieval-insight-layer.md)). Hand-written migration (drizzle-kit can't generate virtual tables).

**Vectorize index `til-entries`** (not in D1): 1024-dim cosine, one vector per `ready` entry (`id` = entry id) over `title + takeaway + summary + tags`; metadata `{ domain, createdAt, embedModel }`. Upserted on `ready`, deleted on entry delete, re-upserted on reingest.

**`settings`** (singleton row, `id = 1`)

| column                                            | notes                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `provider`                                        | `openai` \| `anthropic`                                                                                       |
| `model`                                           | e.g. `gpt-4.1` / `claude-sonnet-4-6`                                                                          |
| `api_key`                                         | BYOK; never returned unmasked; `PUT` is full-replace only ([ADR-0007](./adr/0007-single-user-local-first.md)) |
| `cf_account_id`, `cf_gateway_id`, `cf_aig_token?` | AI Gateway routing                                                                                            |
| `created_at` / `updated_at`                       | epoch ms                                                                                                      |

Migrations: `drizzle-kit generate` → `wrangler d1 migrations apply til`.

## 8. API surface (Hono, under `/api`)

All routes require `Authorization: Bearer <APP_TOKEN>` except `GET /api/health` ([ADR-0007](./adr/0007-single-user-local-first.md)). Exact request/response shapes: [implementation plan, Contract C5](./implementation-plan.md#c5--api-contract).

| Method | Path                        | Purpose                                                                                             |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------- |
| POST   | `/api/entries`              | `{url}` → create `pending` entry, kick off ingest; `409` + existing id on duplicate `canonical_url` |
| GET    | `/api/entries`              | list (keyset-paginated); lazily fails entries `pending` > 10 min                                    |
| GET    | `/api/entries/:id`          | detail (client polls until `ready`)                                                                 |
| DELETE | `/api/entries/:id`          | remove (also deletes the Vectorize vector)                                                          |
| POST   | `/api/entries/:id/reingest` | retry a `failed`/stale entry (re-extracts, re-digests, re-embeds)                                   |
| GET    | `/api/search?q=`            | keyword search over `entries_fts` (M1; hybrid semantic search arrives with M3 tools)                |
| GET    | `/api/settings`             | current config (key masked to last 4)                                                               |
| PUT    | `/api/settings`             | update BYOK config — **full replace only**                                                          |
| POST   | `/api/settings/test`        | `LLMClient.ping()` — validate key/gateway                                                           |
| GET    | `/api/health`               | liveness (no auth)                                                                                  |

## 9. Ingest pipeline

```
POST /api/entries {url}
  → validate + normalize URL (strip trackers; SSRF guards: http/https only,
    no loopback/private/link-local hosts)                       (ADR-0007)
  → insert entry (status=pending)         [return 201 immediately]
  → ctx.waitUntil(ingest):
      1. fetch(url) — realistic UA, 15 s timeout, 5 MB cap,
         re-validate final URL after redirects
      2. Extractor.toMarkdown(html)       → content_markdown    (ADR-0006)
      3. LLMClient.digest(markdown, meta) → {title, summary, takeaway, tags, question}
                                            (AI SDK → CF AI Gateway, BYOK; ADR-0002/0005)
      4. env.AI.run bge-m3 on digest text → VECTORIZE.upsert    (ADR-0009)
      5. update entry (status=ready) — FTS row syncs via trigger
         | on throw: status=failed, error=…
Client polls GET /api/entries/:id until status != pending.
GET /api/entries lazily marks entries pending >10 min as failed (waitUntil is
best-effort; Workflows is the M2 upgrade path for durable ingest).
```

The digest is schema-validated structured output; on validation failure or extraction failure we fail the entry (not the request). Article content is treated as **untrusted data** — the digest prompt forbids following instructions inside it, and the digest path has no tools.

## 10. AI integration

`packages/core` defines the boundary so the rest of the app never imports `ai` or provider packages directly ([ADR-0005](./adr/0005-byok-llmclient-abstraction.md)):

```ts
export interface LLMClient {
  digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
export interface Extractor {
  toMarkdown(
    html: string,
    url: string,
  ): Promise<{ markdown: string; title?: string }>;
}
```

- **`DirectLLMClient`** — hand-written first (learning exercise + guaranteed fallback): plain `fetch` against both provider dialects through the AI Gateway URL.
- **`AISDKClient`** (primary) — `ai` v6 with **explicit** `createOpenAI`/`createAnthropic` instances, `baseURL` → AI Gateway, structured output via the v6 API. Plain model-string IDs are banned — they silently route through Vercel's paid gateway ([ADR-0002 guardrail 1](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)).
- **Embeddings are not part of `LLMClient`** — they use the keyless Workers AI binding (`bge-m3`), independent of the BYOK provider ([ADR-0009](./adr/0009-retrieval-insight-layer.md); Anthropic has no embeddings API).

AI Gateway URL shape:

```
https://gateway.ai.cloudflare.com/v1/{cf_account_id}/{cf_gateway_id}/{provider}/<native path>
  openai    → /openai/chat/completions      Authorization: Bearer <key>
  anthropic → /anthropic/v1/messages        x-api-key: <key>, anthropic-version: <ver>
  (optional gateway auth) cf-aig-authorization: Bearer <cf_aig_token>
```

M2's digest pipeline runs as a **Cloudflare Workflow** (durable steps + cron). M3's chat runs on the **Agents SDK** (`AIChatAgent` Durable Object) with a hand-rolled tool loop over AI SDK primitives and tools defined in [ADR-0009](./adr/0009-retrieval-insight-layer.md) (`search_entries` hybrid retrieval, SQL insight tools).

## 11. Frontend (M1)

- **Shell:** header + nav (Feed / Settings). Tailwind for styling (works identically in the Tauri webview later).
- **Token gate:** first visit asks for the `APP_TOKEN` (stored in `localStorage`, attached as `Authorization` header; a `401` clears it and re-prompts). Skipped transparently in local dev via the dev token.
- **Feed:** "Add a link" input at top → optimistic `pending` card → poll to `ready`; **search box** (`/api/search`); list of cards (title, source domain, takeaway snippet, tags, date); empty state; retry on `failed`; duplicate submission jumps to the existing entry.
- **Entry detail** (route/modal): title, source link, summary, **takeaway**, follow-up question, tags, collapsible extracted markdown, reingest/delete.
- **Settings:** provider select, model, API key (password field, masked once saved), CF account id + gateway id + optional gateway token, **Test connection**.
- Data fetching via TanStack Query.

## 12. Milestones

- **M1 — Web thin slice (this design).** Everything in §7–§11, including the ingest-time index (vectors + FTS). Single-tenant, single user. _Definition of done in §13; phase-by-phase plan with agent briefs in the [implementation plan](./implementation-plan.md)._
- **M1.5 — Deploy hardening.** `APP_TOKEN` + optional CF Access, create real D1/Vectorize/AI Gateway, `wrangler deploy`, scheduled D1 export → R2, optionally move the BYOK key to gateway-stored keys ([ADR-0007](./adr/0007-single-user-local-first.md)).
- **M2 — Interesting-things digest.** A **Cloudflare Workflow** (durable steps: query-plan → multi-source fetch across free sources (Reddit/HN/web) → rank into scored "evidence clusters" → synthesize) + AI SDK calls, scheduled via Cron Triggers — the `mvanhorn/last30days-skill` _pattern_, Worker-native. A pipeline, not an autonomous agent.
- **M3 — Chat agent.** Agents SDK (`AIChatAgent` DO: WebSocket streaming, persisted sessions) + hand-rolled tool loop over AI SDK; tools per [ADR-0009](./adr/0009-retrieval-insight-layer.md): hybrid `search_entries` (Vectorize + FTS5 + RRF), SQL insight tools ("most interesting this month", habit stats). UI: AI Elements / assistant-ui. "Ask about your learning." Tool outputs are data, not instructions — chat tools are read-only.
- **M4 — Desktop + mobile.** PWA pass first (installability, zero store friction), then wrap the same client build with Tauri 2. Client API base URL becomes configurable; API adds CORS for the Tauri origin. Store-distribution caveats noted in [ADR-0001](./adr/0001-cross-platform-web-first-tauri2.md).
- **M5 — (optional).** Multi-user (auth + per-user keys + multi-tenant D1), Browser-Rendering extraction, spaced-repetition review.

## 13. Verification (M1 definition of done)

1. `pnpm dev` runs Vite + local Worker (miniflare) + local D1 + local Vectorize.
2. `wrangler d1 create til`; bindings wired; migrations applied `--local` (incl. FTS5 + triggers).
3. **Settings** → enter BYOK provider + real key + CF account/gateway ids → **Test connection** returns OK. (Dev shortcut: `DirectLLMClient` may call the provider directly if no gateway exists yet.)
4. **Feed** → paste a real article URL → card goes `pending` → `ready` with a genuine takeaway/summary/tags → search finds it by a keyword → open detail → delete works (and removes its vector).
5. Paywalled / JS-heavy URL → graceful `failed` card (documents the extraction limit). Duplicate URL → 409, UI jumps to existing entry.
6. Requests without the bearer token get `401` (except `/api/health`); `PUT /api/settings` rejects partial bodies.
7. Typecheck + lint + unit tests clean (per-phase DoD commands in the [implementation plan](./implementation-plan.md)). No deploy until explicitly requested (`wrangler deploy` is a real external action needing the CF account).

## 14. Risks & mitigations

| Risk                                                                     | Mitigation                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed Worker holds BYOK key with weak auth → wallet-drain / key exfil | Bearer `APP_TOKEN` mandatory before deploy; full-replace `PUT /api/settings`; optional CF Access ([ADR-0007](./adr/0007-single-user-local-first.md))                                                                                   |
| SSRF / open proxy via ingest URL                                         | Scheme allowlist, private-host blocks, size/time caps, final-URL revalidation ([ADR-0007](./adr/0007-single-user-local-first.md))                                                                                                      |
| AI SDK major-version churn (v4→v5→v6→v7)                                 | Exact-pin `ai@6.x`; all imports contained in `packages/core` behind `LLMClient`; `DirectLLMClient` fallback ([ADR-0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0005](./adr/0005-byok-llmclient-abstraction.md)) |
| Accidental routing through Vercel's paid gateway                         | Guardrail: explicit provider instances only, plain model strings banned ([ADR-0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md))                                                                                       |
| Prompt injection via ingested content                                    | Digest path has no tools; content framed as untrusted data; M3 chat tools are read-only ([ADR-0005](./adr/0005-byok-llmclient-abstraction.md))                                                                                         |
| `waitUntil` is best-effort → stuck `pending` entries                     | Lazy stale sweep (>10 min → `failed`) + manual reingest; Cloudflare Workflows is the durable upgrade path (M2)                                                                                                                         |
| Extraction fails (paywall/JS/bot)                                        | Fail entry gracefully + retry; Browser Rendering fallback in M-later ([ADR-0006](./adr/0006-content-extraction-to-markdown.md))                                                                                                        |
| AI Gateway needs CF account/gateway                                      | Dev can bypass to provider-direct via `DirectLLMClient`                                                                                                                                                                                |
| Worker CPU/time/bundle limits, extraction cost                           | Likely a paid Workers plan; async ingest via `waitUntil`; no `nodejs_compat` keeps the bundle lean                                                                                                                                     |
| BYOK key at rest in D1                                                   | Masked in responses; M1.5: envelope encryption or AI Gateway stored keys ([ADR-0007](./adr/0007-single-user-local-first.md))                                                                                                           |
| Single copy of a growing knowledge base                                  | M1.5: scheduled D1 export → R2; documented manual `wrangler d1 export`                                                                                                                                                                 |
| Embedding model change invalidates index                                 | `embedModel` recorded in vector metadata; re-embed is a batch reprocess ([ADR-0009](./adr/0009-retrieval-insight-layer.md))                                                                                                            |

## 15. Prerequisites

Cloudflare account (D1 + AI Gateway + deploy), one provider API key (OpenAI or Anthropic), Node ≥ 20, pnpm.

## 16. Open questions

Resolved in v2: ~~Pi namespace~~ (Pi dropped — [ADR-0002 v2](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)); ~~ingest latency~~ (`waitUntil` + polling + lazy stale sweep); ~~encrypt key in M1~~ (defer — auth + full-replace `PUT` instead; M1.5 options in [ADR-0007](./adr/0007-single-user-local-first.md)).

Still open:

- Default provider/model for first run (decide at P5 integration; cosmetic).
- AI SDK v7: evaluate after M1 ships (migration budget ~1 day; stay pinned to v6 until then).
- M2 source strategy: which free sources + whether a search API (e.g. Brave free tier) is needed — decide at M2 kickoff.
- M1.5: adopt AI Gateway gateway-stored provider keys (removes `api_key` from D1) — verify feature maturity then.
