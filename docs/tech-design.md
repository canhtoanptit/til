# Technical Design — TIL ("Today I Learned")

- **Status:** Proposed (under review)
- **Date:** 2026-08-02
- **Related:** ADRs [0001](./adr/0001-cross-platform-web-first-tauri2.md)–[0008](./adr/0008-monorepo-pnpm-turborepo.md)

---

## 1. Problem statement

Interesting things are read once and lost. I want a low-friction way to **capture what I learn** — usually just a link — and have the system do the work of turning it into something durable and useful: a short summary, the single most interesting takeaway, tags, and a follow-up question worth exploring. Over time this becomes a searchable feed, a periodic digest of interesting things, and something I can *chat with* about my own learning habits.

Secondary goal: this is a deliberate playground for building a small **AI system** — configurable agents and a bring-your-own-key (BYOK) LLM gateway — deployed on Cloudflare.

## 2. Goals / non-goals

**Goals**
- Paste a URL → automatic content extraction → LLM digest (summary + takeaway + tags + question) → stored and browsable.
- BYOK: I configure the provider (OpenAI/Anthropic) and my own API key in-app; calls routed through a gateway I control.
- Cross-platform: web first, then desktop and mobile from the same codebase.
- Runs on Cloudflare (Workers + D1 + AI Gateway).
- Extensible toward agents: a digest agent and a chat agent.

**Non-goals (for now)**
- Multi-user / accounts / sharing (single-user, local-first — see [ADR-0007](./adr/0007-single-user-local-first.md)).
- Beating paywalls or scraping bot-protected sites.
- Native (non-webview) mobile UI.
- Real-time collaboration.

## 3. Users & scope

One user (me), running my own instance. BYOK key and all data live in my own Cloudflare D1. No authentication in M1.

## 4. High-level architecture

```
┌───────────────────────────────────────────────────────────┐
│                    Cloudflare Worker                        │
│                                                             │
│  React+Vite SPA  ──(static assets binding: env.ASSETS)      │
│        │                                                    │
│        │  fetch /api/*                                       │
│        ▼                                                    │
│   Hono API  ──────────────► D1 (SQLite)  [entries, settings]│
│        │                                                    │
│        │  ingest()                                          │
│        ├──► env.AI.toMarkdown()   (HTML → markdown)         │
│        └──► LLMClient (Pi) ──► Cloudflare AI Gateway ──► LLM │
│                                   (BYOK: OpenAI/Anthropic)   │
└───────────────────────────────────────────────────────────┘
        ▲
        │ same client build wrapped later by Tauri 2
   Web / Desktop / Mobile
```

One full-stack Worker (via `@cloudflare/vite-plugin`) serves the SPA *and* the API. The LLM is never called directly by the browser — the Worker holds the BYOK key and routes through **Cloudflare AI Gateway** for caching, rate-limiting, and cost/observability.

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
    core/                   # domain types, ingest pipeline, LLMClient interface + Pi adapter
    db/                     # Drizzle schema + migrations for D1
  docs/                     # these documents
  package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
```
Rationale for the monorepo split: [ADR-0008](./adr/0008-monorepo-pnpm-turborepo.md). Later: `packages/ui` (shared components incl. `pi-web-ui` chat) and `apps/native` (Tauri).

## 6. Technology choices

| Layer | Choice | ADR |
|-------|--------|-----|
| Frontend | React + Vite (web-first), Tailwind, React Router, TanStack Query | [0001](./adr/0001-cross-platform-web-first-tauri2.md) |
| Desktop/mobile (later) | Tauri 2 wrapping the same build | [0001](./adr/0001-cross-platform-web-first-tauri2.md) |
| API | Hono on Cloudflare Workers | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md) |
| Build/deploy | `@cloudflare/vite-plugin` (single Worker) | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md) |
| Database | Cloudflare D1 + Drizzle | [0004](./adr/0004-database-d1-drizzle.md) |
| LLM | Pi (`pi-ai`) via Cloudflare AI Gateway, BYOK | [0002](./adr/0002-ai-stack-pi-cloudflare-ai-gateway.md), [0005](./adr/0005-byok-llmclient-abstraction-nodejs-compat.md) |
| Agents (M2/M3) | `pi-agent-core` | [0002](./adr/0002-ai-stack-pi-cloudflare-ai-gateway.md) |
| Extraction | `env.AI.toMarkdown()` + Browser Rendering fallback | [0006](./adr/0006-content-extraction-to-markdown.md) |

## 7. Data model (D1)

**`entries`**

| column | type | notes |
|--------|------|-------|
| `id` | text (pk) | uuid |
| `url` | text | as submitted |
| `canonical_url` | text | normalized |
| `title` | text | from extraction/LLM |
| `source_domain` | text | e.g. `arxiv.org` |
| `content_markdown` | text | extracted body |
| `summary` | text | LLM |
| `takeaway` | text | LLM — the single most interesting point |
| `question` | text | LLM — a follow-up worth exploring |
| `tags` | text (json) | LLM — string[] |
| `status` | text | `pending` \| `ready` \| `failed` |
| `error` | text | when `failed` |
| `created_at` / `updated_at` | integer | epoch ms |

**`settings`** (singleton row, `id = 1`)

| column | notes |
|--------|-------|
| `provider` | `openai` \| `anthropic` |
| `model` | e.g. `gpt-4.1` / `claude-sonnet-4-6` |
| `api_key` | BYOK; never returned unmasked ([ADR-0007](./adr/0007-single-user-local-first.md)) |
| `cf_account_id`, `cf_gateway_id`, `cf_aig_token?` | AI Gateway routing |
| `created_at` / `updated_at` | epoch ms |

Migrations: `drizzle-kit generate` → `wrangler d1 migrations apply til`.

## 8. API surface (Hono, under `/api`)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/entries` | `{url}` → create `pending` entry, kick off ingest |
| GET | `/api/entries` | list (paginated) |
| GET | `/api/entries/:id` | detail (client polls until `ready`) |
| DELETE | `/api/entries/:id` | remove |
| POST | `/api/entries/:id/reingest` | retry a `failed`/stale entry |
| GET | `/api/settings` | current config (key masked) |
| PUT | `/api/settings` | update BYOK config |
| POST | `/api/settings/test` | `LLMClient.ping()` — validate key/gateway |
| GET | `/api/health` | liveness |

## 9. Ingest pipeline

```
POST /api/entries {url}
  → insert entry (status=pending)         [return immediately]
  → ctx.waitUntil(ingest):
      1. normalize URL (strip trackers, resolve canonical)
      2. fetch(url) with a realistic UA header
      3. env.AI.toMarkdown(html)          → content_markdown   (ADR-0006)
      4. LLMClient.digest(markdown, meta) → {title, summary, takeaway, tags, question}
                                            (Pi → AI Gateway, BYOK; ADR-0002/0005)
      5. update entry (status=ready) | on throw: status=failed, error=…
Client polls GET /api/entries/:id until status != pending.
```
The digest prompt asks for a strict JSON object; we parse defensively and fail the entry (not the request) on malformed output or extraction failure.

## 10. AI integration

`packages/core` defines the boundary so the rest of the app never imports Pi directly ([ADR-0005](./adr/0005-byok-llmclient-abstraction-nodejs-compat.md)):

```ts
export interface LLMClient {
  digest(markdown: string, meta: { url: string; title?: string }): Promise<Digest>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
```
- **`PiLLMClient`** — uses `pi-ai` with `baseUrl` set to the AI Gateway endpoint for the configured provider, BYOK auth header from `settings`, and the Worker's `fetch` injected. Pi version pinned; namespace (`@mariozechner/*` vs `@earendil-works/*`) decided at install time.
- **`DirectLLMClient`** (fallback) — a plain `fetch` to the same AI Gateway URL. Guarantees the slice ships even if Pi fights the Workers runtime.

AI Gateway URL shape:
```
https://gateway.ai.cloudflare.com/v1/{cf_account_id}/{cf_gateway_id}/{provider}/<native path>
  openai    → /openai/chat/completions      Authorization: Bearer <key>
  anthropic → /anthropic/v1/messages        x-api-key: <key>, anthropic-version: <ver>
  (optional gateway auth) cf-aig-authorization: Bearer <cf_aig_token>
```
`pi-agent-core` (the LLM+tool loop) is introduced in M2/M3 for the digest and chat agents.

## 11. Frontend (M1)

- **Shell:** header + nav (Feed / Settings). Tailwind for styling (works identically in the Tauri webview later).
- **Feed:** "Add a link" input at top → optimistic `pending` card → poll to `ready`; list of cards (title, source domain, takeaway snippet, tags, date); empty state; retry on `failed`.
- **Entry detail** (route/modal): title, source link, summary, **takeaway**, follow-up question, tags, collapsible extracted markdown, reingest/delete.
- **Settings:** provider select, model, API key (password field, masked once saved), CF account id + gateway id + optional gateway token, **Test connection**.
- Data fetching via TanStack Query.

## 12. Milestones

- **M1 — Web thin slice (this design).** Everything in §7–§11. Local-first, single user. *Definition of done in §13.*
- **M2 — Interesting-things digest.** A `pi-agent-core` agent with web-search/fetch tools that fans out across free sources (Reddit/HN/web), ranks results into scored "evidence clusters", and writes a periodic digest — modeled on `mvanhorn/last30days-skill` (query-plan → multi-source fetch → rank → synthesize). Scheduled via Cron Triggers. Note: the real skill needs Python+node and can't run in a Worker; we reimplement the *pattern*, Worker-native.
- **M3 — Chat agent.** `pi-agent-core` + `pi-web-ui` chat, with tools that query D1 (search entries, "most interesting this month", habit stats). "Ask about your learning."
- **M4 — Desktop + mobile.** Wrap the same client build with Tauri 2. Client API base URL becomes configurable (points at local/deployed Worker). Store-distribution caveats noted in [ADR-0001](./adr/0001-cross-platform-web-first-tauri2.md).
- **M5 — (optional).** Multi-user (auth + per-user keys + multi-tenant D1), Browser-Rendering extraction, spaced-repetition review.

## 13. Verification (M1 definition of done)

1. `pnpm dev` runs Vite + local Worker (miniflare) + local D1.
2. `wrangler d1 create til`; binding wired; migrations applied `--local`.
3. **Settings** → enter BYOK provider + real key + CF account/gateway ids → **Test connection** returns OK. (Dev shortcut: `DirectLLMClient` may call the provider directly if no gateway exists yet.)
4. **Feed** → paste a real article URL → card goes `pending` → `ready` with a genuine takeaway/summary/tags → open detail → delete works.
5. Paywalled / JS-heavy URL → graceful `failed` card (documents the extraction limit).
6. Typecheck + lint clean. No deploy until explicitly requested (`wrangler deploy` is a real external action needing the CF account).

## 14. Risks & mitigations

| Risk | Mitigation |
|------|------------|
| `pi-ai` needs `node:fs` → Workers | Enable `nodejs_compat`; `LLMClient` fallback = `DirectLLMClient` ([ADR-0005](./adr/0005-byok-llmclient-abstraction-nodejs-compat.md)) |
| Pi package namespace churn | Pin versions; hide behind `LLMClient` |
| Extraction fails (paywall/JS/bot) | Fail entry gracefully + retry; Browser Rendering fallback in M-later ([ADR-0006](./adr/0006-content-extraction-to-markdown.md)) |
| AI Gateway needs CF account/gateway | Dev can bypass to provider-direct via `DirectLLMClient` |
| Worker CPU/time/bundle limits, extraction cost | Likely a paid Workers plan; async ingest via `waitUntil` |
| BYOK key at rest | Stored in own D1, masked in responses; optional encryption later |

## 15. Prerequisites

Cloudflare account (D1 + AI Gateway + deploy), one provider API key (OpenAI or Anthropic), Node ≥ 20, pnpm.

## 16. Open questions

- Pi package namespace: `@mariozechner/pi-*` (older-stable) vs `@earendil-works/pi-*` (current)? Decide at install.
- Default provider/model for first run?
- Ingest latency: keep synchronous-with-spinner, or `waitUntil` + polling (current plan)?
- Encrypt the BYOK key at rest in M1, or defer?
