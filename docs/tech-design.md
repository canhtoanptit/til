# Technical Design — TIL ("Today I Learned")

- **Status:** Accepted (v2, 2026-08-02 — AI stack revised to Vercel AI SDK, retrieval layer and auth added after review)
- **Date:** 2026-08-02
- **Related:** ADRs [0001](./adr/0001-cross-platform-web-first-tauri2.md)–[0013](./adr/0013-google-identity-session-cookies.md) · [Implementation plan](./implementation-plan.md)

---

## 1. Problem statement

Interesting things are read once and lost. I want a low-friction way to **capture what I learn** — usually just a link — and have the system do the work of turning it into something durable and useful: a short summary, the single most interesting takeaway, tags, and a follow-up question worth exploring. Over time this becomes a searchable feed, a periodic digest of interesting things, and something I can _chat with_ about my own learning habits.

Secondary goal: this is a deliberate playground for building a small **AI system** — configurable agents and a bring-your-own-key (BYOK) LLM gateway — deployed on Cloudflare.

## 2. Goals / non-goals

**Goals**

- Paste a URL → automatic content extraction → LLM digest (summary + takeaway + tags + question) → stored and browsable.
- BYOK: I configure the provider (OpenAI/Anthropic/Groq) and my own API key in-app; calls routed through a gateway I control.
- Cross-platform: web first, then desktop and mobile from the same codebase.
- Runs on Cloudflare (Workers + D1 + AI Gateway).
- Extensible toward agents: a digest agent and a chat agent.

**Non-goals (for now)**

- Sharing between users. Accounts do exist since 2026-09-05 — Google sign-in and per-user tenancy ([ADR-0013](./adr/0013-google-identity-session-cookies.md)) — but a library is private to its owner and there is nothing to publish, follow or share.
- Beating paywalls or scraping bot-protected sites.
- Native (non-webview) mobile UI.
- Real-time collaboration.

## 3. Users & scope

Anyone with a Google account, on one deployed instance, each seeing only their own data ([ADR-0013](./adr/0013-google-identity-session-cookies.md), which supersedes ADR-0007's single-tenant stance). Every user brings their own provider key and gets their own `settings` row; all data lives in the operator's Cloudflare D1, scoped by a `user_id` column on every owned row. Sign-in is a Google OIDC code flow; a `til_session` cookie (D1-backed, 30-day TTL) authenticates every `/api/*` call, including the chat WebSocket upgrade. Local dev signs in through a dev-login form that exists only when `TIL_STACK=local`. Entry creation is capped at **10 saves per user per UTC day**.

## 4. High-level architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker ("til")                     │
│                                                                   │
│  React+Vite SPA ──(static assets binding: env.ASSETS)             │
│        │                                                          │
│        │  fetch /api/*  (til_session cookie)                      │
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

| Layer                   | Choice                                                                                              | ADR                                                                                                                  |
| ----------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Frontend                | React + Vite (web-first), Tailwind, React Router, TanStack Query                                    | [0001](./adr/0001-cross-platform-web-first-tauri2.md)                                                                |
| Desktop/mobile (later)  | Tauri 2 wrapping the same build                                                                     | [0001](./adr/0001-cross-platform-web-first-tauri2.md)                                                                |
| API                     | Hono on Cloudflare Workers                                                                          | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)                                                         |
| Build/deploy            | `@cloudflare/vite-plugin` (single Worker)                                                           | [0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)                                                         |
| Database                | Cloudflare D1 + Drizzle                                                                             | [0004](./adr/0004-database-d1-drizzle.md)                                                                            |
| LLM                     | Vercel AI SDK v6 via Cloudflare AI Gateway, BYOK (explicit providers only)                          | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0005](./adr/0005-byok-llmclient-abstraction.md) |
| Retrieval & insight     | Workers AI `bge-m3` + Vectorize + D1 FTS5, embed at ingest                                          | [0009](./adr/0009-retrieval-insight-layer.md)                                                                        |
| M2 digest pipeline      | Cloudflare Workflows + Cron Triggers + AI SDK                                                       | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)                                                   |
| M3 chat                 | Cloudflare Agents SDK (`AIChatAgent` DO, WebSocket-only) + `streamChat` in core; UI: `useAgentChat` | [0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0009](./adr/0009-retrieval-insight-layer.md)    |
| Local vs cloud adapters | `TIL_STACK=local` (Readability + Ollama bge-m3 + D1 cosine) vs `cloud` (Workers AI + Vectorize)     | [0010](./adr/0010-dual-mode-local-cloud-stack.md)                                                                    |
| Extraction              | `env.AI.toMarkdown()` behind `Extractor` seam + Browser Rendering fallback                          | [0006](./adr/0006-content-extraction-to-markdown.md)                                                                 |
| Auth & tenancy          | Google OIDC code flow → D1-backed `til_session` cookie; `user_id` on every owned row                | [0013](./adr/0013-google-identity-session-cookies.md), [0007](./adr/0007-single-user-local-first.md)                 |

## 7. Data model (D1)

**`entries`**

| column                      | type        | notes                                   |
| --------------------------- | ----------- | --------------------------------------- |
| `id`                        | text (pk)   | uuid                                    |
| `user_id`                   | text        | owning user (0012; see below)           |
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

Indexes: **unique on `(user_id, canonical_url)`** (dedupe is per user — resubmitting a URL returns _your_ existing entry, and two people may save the same link), plus `(status)`, `(created_at desc)`, `(user_id, created_at)`.

**`entries_fts`** — FTS5 external-content virtual table over `title, summary, takeaway, tags, content_markdown`, synced by insert/update/delete triggers ([ADR-0009](./adr/0009-retrieval-insight-layer.md)). Hand-written migration (drizzle-kit can't generate virtual tables).

**Vectorize index `til-entries`** (not in D1): 1024-dim cosine, one vector per `ready` entry (`id` = entry id) over `title + takeaway + summary + tags`; metadata `{ domain, createdAt, embedModel }`. Upserted on `ready`, deleted on entry delete, re-upserted on reingest. **Tenancy is a namespace, not a metadata filter**: every vector is written and queried under `namespace = user_id`, which needs no metadata-index creation step and cannot be forgotten at query time ([ADR-0013](./adr/0013-google-identity-session-cookies.md)). The local-mode `entry_vectors` store carries no user column and scopes by joining its parent `entries` row instead.

**`users`** — `id` (text pk; `crypto.randomUUID()`, or the literal `'owner'` for the pre-0012 tenant), unique nullable `google_sub`, `email`, `name`, `picture`, `created_at`/`updated_at`. The `owner` row is seeded by migration 0012 with a sentinel email and a NULL `google_sub`; the first verified Google account matching the `OWNER_EMAIL` secret claims it, and with it every row that predates multi-user.

**`sessions`** — `id` (256-bit hex, the value of the `til_session` cookie), `user_id` (FK → `users`, cascade), `created_at`, `expires_at`. Fixed 30-day TTL, no sliding renewal; expired rows are swept opportunistically on the read that finds them.

**`settings`** (one row per user — `UNIQUE(user_id)`; BYOK is per user, and ingest reads the settings of the entry's owner)

| column                                            | notes                                                                                                                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`                                         | owning user (unique)                                                                                                                         |
| `provider`                                        | `openai` \| `anthropic` \| `groq`                                                                                                            |
| `model`                                           | e.g. `gpt-4.1` / `claude-sonnet-4-6`                                                                                                         |
| `api_key`                                         | BYOK; never returned unmasked; `PUT` full-replace except keep-key-when-routing-unchanged ([ADR-0007](./adr/0007-single-user-local-first.md)) |
| `cf_account_id`, `cf_gateway_id`, `cf_aig_token?` | AI Gateway routing                                                                                                                           |
| `created_at` / `updated_at`                       | epoch ms                                                                                                                                     |

Built since v2 (see migrations): `digests` + `digest_items` (M2), `entry_vectors` (local-mode vector store, [ADR-0010](./adr/0010-dual-mode-local-cloud-stack.md)), `chats` conversation index (M3).

Built in M-FEAT1 / M-FEAT2 (migrations `0005`–`0011`): `feeds` (digest source list, replacing the hardcoded defaults), `reviews` (SM-2-lite state keyed to `entries.id`), `feedback` (👍/👎 on chat answers), a nullable `interest_score` on `digest_items` for personalized ranking, a `kind` on `digests` (`weekly` | `monthly-report`), and on `entries` a `content_type` plus the library columns `favorite`, `archived`, `note`.

Built in M5 (migration `0012_multi_user`, [ADR-0013](./adr/0013-google-identity-session-cookies.md)): `users` + `sessions`, and a `user_id TEXT NOT NULL DEFAULT 'owner'` column on `entries`, `digests`, `feeds`, `reviews`, `feedback`, `chats` and `settings` — the SQL default _is_ the backfill for a deployed single-user database, not an app behaviour, so the Drizzle columns omit it and every insert site must name its user or fail to compile. `digest_items` and `entry_vectors` deliberately get none; they hang off a parented row and are scoped by joining it. Uniqueness moved from global to per-user (`entries (user_id, canonical_url)`, `feeds (user_id, url)`, `settings UNIQUE(user_id)`), and the FTS triggers name their columns explicitly, so `user_id` is invisible to the keyword index. Next free migration number: `0013`.

Migrations: hand-numbered SQL, applied by filename sort via `wrangler d1 migrations apply til`. Most are hand-written, not generated — the policy and the `db:generate` footgun are documented in [`packages/db/migrations/README.md`](../packages/db/migrations/README.md).

## 8. API surface (Hono, under `/api`)

All routes require a live `til_session` cookie except `GET /api/health` and the `/api/auth/*` entry points; without one the answer is `401 unauthorized` ([ADR-0013](./adr/0013-google-identity-session-cookies.md)). Every authenticated route is scoped to the session's user — another user's id is a `404`, never someone else's row. Exact request/response shapes: [implementation plan, Contract C5](./implementation-plan.md#c5--api-contract).

| Method | Path                        | Purpose                                                                                                                                                                      |
| ------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/entries`              | `{url}` → create `pending` entry, kick off ingest; `409` + existing id on duplicate `canonical_url`; `429 rate_limited` + `Retry-After` past 10 saves/UTC-day                |
| GET    | `/api/entries`              | list (keyset-paginated); `?filter=favorites\|archived` and `?tag=` narrow it; lazily fails entries `pending` > 10 min                                                        |
| GET    | `/api/entries/:id`          | detail (client polls until `ready`)                                                                                                                                          |
| PATCH  | `/api/entries/:id`          | library edits — any of `{favorite, archived, note}`; empty-string note clears it to null                                                                                     |
| DELETE | `/api/entries/:id`          | remove (also deletes the Vectorize vector)                                                                                                                                   |
| GET    | `/api/entries/:id/related`  | nearest neighbours by vector (`?limit=`, ≤20); `{available:false}` when there is no embedder or no vector                                                                    |
| POST   | `/api/entries/:id/reingest` | retry a `failed`/stale entry (re-extracts, re-digests, re-embeds)                                                                                                            |
| POST   | `/api/entries/reembed`      | backfill vectors for `ready` entries missing them (after enabling an embedder)                                                                                               |
| GET    | `/api/tags`                 | tag facets `{tag, count}` for the browse UI, count desc; archived entries excluded                                                                                           |
| GET    | `/api/search?q=`            | hybrid search — vector + `entries_fts` fused by RRF, degrading to FTS-only with no embedder                                                                                  |
| GET    | `/api/reviews/queue`        | due cards + `dueCount` (`?limit=`, ≤50) — question side only, so the answer stays hidden                                                                                     |
| POST   | `/api/reviews/enroll`       | add cards: `{entryId}` for one, `{all:true}` to backfill every `ready` entry without one                                                                                     |
| POST   | `/api/reviews/:entryId`     | grade a card `{grade:1–4}` → next SM-2-lite state (`dueAt`, `intervalDays`, `ease`, `lapses`)                                                                                |
| GET    | `/api/digests`              | list digest runs; `GET /:id` detail, `DELETE /:id`; lazily fails runs `pending` > 15 min                                                                                     |
| POST   | `/api/digests/run`          | manual trigger (202) — optional `{windowDays, maxItems, kind}`; `kind` is `weekly` (default) or `monthly-report`, strict                                                     |
| GET    | `/api/feeds`                | feed list; `POST` add `{url}` (`409` on duplicate), `PUT /:id` `{enabled}` to pause, `DELETE /:id`                                                                           |
| POST   | `/api/feedback`             | 👍/👎 `{kind}` plus optional `{conversationId, messageId, entryId, comment}` — write-only signal, no dedupe                                                                  |
| WS     | `/api/chat/:id`             | **WebSocket only** — chat turns as Agents SDK frames; there is no HTTP chat endpoint. Authenticated by the `til_session` cookie, which rides the same-origin upgrade request |
| GET    | `/api/chat`                 | conversation list; `GET /:id/messages` transcript; `DELETE /:id` clears it                                                                                                   |
| GET    | `/api/settings`             | current config (key masked to last 4)                                                                                                                                        |
| PUT    | `/api/settings`             | update BYOK config — full replace; `apiKey` omittable only if provider/account/gateway unchanged                                                                             |
| POST   | `/api/settings/test`        | `LLMClient.ping()` — validate key/gateway                                                                                                                                    |
| GET    | `/api/health`               | liveness (no auth)                                                                                                                                                           |
| GET    | `/api/auth/google`          | start sign-in — sets the 10-min `til_oauth_state` cookie, `302` to Google (`503` until the OAuth secrets are set)                                                            |
| GET    | `/api/auth/callback`        | Google's redirect target — verifies state + `id_token` claims, upserts the user, sets `til_session`, `302` to `/`                                                            |
| GET    | `/api/auth/me`              | the signed-in user `{id, email, name, picture}`, or `401`                                                                                                                    |
| POST   | `/api/auth/logout`          | deletes the session row and clears the cookie; `204` whatever the cookie was                                                                                                 |
| POST   | `/api/auth/dev-login`       | `{email}` → a session without Google. Exists **only** when `TIL_STACK=local`; `404` otherwise, before body validation                                                        |
| GET    | `/api/export`               | streamed full backup as JSON; `?format=markdown` for a single readable `.md` bundle (see below)                                                                              |

### 8.1 What an export deliberately leaves out

`GET /api/export` is the owner's escape hatch under [ADR-0007](./adr/0007-single-user-local-first.md)'s "one copy is zero copies". It streams (keyset-batched per table) rather than buffering, because `content_markdown` holds whole articles and a Worker has ~128 MB.

Three tables are **not** in it, and every exported file repeats the reasons inside itself:

- **`settings`** — the row holds the provider API key in cleartext. An export lands in a downloads folder and gets synced and mailed around; a backup that is also a copy of a secret is a liability, not a safety net. Re-enter the key after a restore.
- **`entry_vectors`** — recomputable via `POST /api/entries/reembed`, and at ~1024 floats per entry it would dominate the file size.
- **`chats`** — only a cross-Durable-Object index; the transcripts live in each chat DO's own storage, which D1 cannot read, so exporting the index would promise conversations the file does not contain.

The markdown variant is one document, not an archive: a zip would mean a new runtime dependency the Workers runtime does not provide. It is also deliberately lossy — entries and digests only — so the JSON stays the single restore format.

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
- **Sign-in gate:** the app asks `GET /api/auth/me` before rendering anything; without a session it shows a login page with **Continue with Google** — plus a dev-login email form when `/api/health` reports `stack: local`. The shell carries the signed-in identity and a sign-out action; a `401` from any call drops back to the login page ([ADR-0013](./adr/0013-google-identity-session-cookies.md)). _(Was a token gate over `localStorage` until 2026-09-05.)_
- **Feed:** "Add a link" input at top → optimistic `pending` card → poll to `ready`; **search box** (`/api/search`); list of cards (title, source domain, takeaway snippet, tags, date); empty state; retry on `failed`; duplicate submission jumps to the existing entry.
- **Entry detail** (route/modal): title, source link, summary, **takeaway**, follow-up question, tags, collapsible extracted markdown, reingest/delete.
- **Settings:** provider select, model, API key (password field, masked once saved), CF account id + gateway id + optional gateway token, **Test connection**.
- Data fetching via TanStack Query.

## 12. Milestones

- **M1 — Web thin slice (this design). ✅ Complete, verified 2026-08-03** (Groq via authenticated CF AI Gateway; real `ready` digest + live FTS hit). Everything in §7–§11, including the ingest-time index (vectors + FTS). Single-tenant, single user. _Definition of done in §13; phase-by-phase plan with agent briefs in the [implementation plan](./implementation-plan.md)._
- **Deploy hardening (was M1.5 — deferred to after M3 on 2026-08-03).** Everything through M3 is built and verified locally first; Workers AI and Vectorize have no local emulator, so local runs use substitute adapters (Readability extraction, Ollama/remote `bge-m3`, D1 brute-force cosine) behind the existing seams. `APP_TOKEN` + optional CF Access, create real D1/Vectorize/AI Gateway, `wrangler deploy`, scheduled D1 export → R2, optionally move the BYOK key to gateway-stored keys ([ADR-0007](./adr/0007-single-user-local-first.md)). _(The token shipped as described and was retired in M5 — [ADR-0013](./adr/0013-google-identity-session-cookies.md).)_
- **M2 — Interesting-things digest.** A **Cloudflare Workflow** (durable steps: query-plan → multi-source fetch across keyless sources (HN/Lobsters/arXiv/RSS — **Reddit dropped: unauthenticated JSON returned 403 from May 2026 and OAuth is closed to personal scripts**) → rank into scored "evidence clusters" → synthesize) + AI SDK calls, scheduled via Cron Triggers — the `mvanhorn/last30days-skill` _pattern_, Worker-native. A pipeline, not an autonomous agent.
- **M3 — Chat agent. Backend complete 2026-08-08** (UI in progress). Agents SDK `AIChatAgent` on a Durable Object with SQLite-persisted sessions; the AI-SDK tool loop lives in `packages/core` as `streamChat`, so the DO never imports `ai`. Tools per [ADR-0009](./adr/0009-retrieval-insight-layer.md): hybrid `search_entries` (vector + FTS5 fused by RRF), `get_entry`, `stats`. All read-only; tool output is framed as untrusted data. Three implementation realities worth carrying forward: chat is **WebSocket-only** (`@cloudflare/ai-chat` exposes no HTTP chat path), the WS handshake was authorised by a **60 s HMAC ticket** because browsers cannot set handshake headers ([ADR-0007](./adr/0007-single-user-local-first.md); retired 2026-09-05 — cookies ride a same-origin upgrade, so the session cookie authorises it directly, [ADR-0013](./adr/0013-google-identity-session-cookies.md)), and the Agents SDK **re-requires `nodejs_compat`** ([ADR-0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md)).
  _The following milestones were added 2026-08-09 after M3 shipped; M4/M5 keep their historical numbers because other docs reference them. Execution order (reordered same day — deploy moved ahead of the feature waves once the owner adopted an all-on-Cloudflare posture; their machine cannot run Ollama): M-EVAL → M-UI → **deploy** → M-FEAT1 → M-FEAT2 → M4._

- **M-EVAL — Measurement** ([ADR-0011](./adr/0011-evaluation-and-measurement.md)). `@til/evals`: golden-set retrieval metrics (Recall@5, MRR, nDCG@10; FTS-vs-vector-vs-hybrid ablation), deterministic chat checks (tool selection, citation precision, refusal, injection canaries), opt-in LLM-judge suite (faithfulness/relevance, judge ≠ generator), history log per run. Prerequisite: local Ollama `bge-m3`. Online half (feedback thumbs, click-through) lands post-deploy.
- **M-UI — Design system** ([ADR-0012](./adr/0012-ui-system-shadcn.md)). shadcn/ui vendored refresh of the existing six pages (dialogs replace `window.confirm`, sonner toasts, proper tables/collapsibles/badges) + dark mode + ⌘K palette over hybrid search. Pure restyle; lands before new feature UIs.
- **M-FEAT1 — Features wave 1** (rides existing infrastructure; each measurable via M-EVAL):
  - _Related entries_ — "more like this" on the detail page via the entry's own vector.
  - _Personalized digest ranking_ — blend the digest's base score with similarity to the user's saved entries; degrades to base score without an embedder.
  - _Review queue_ — spaced repetition over the until-now-unused `question` field (SM-2-lite; `reviews` table).
  - _Digest sources UI_ — `feeds` table + settings section replacing the hardcoded `DEFAULT_RSS_FEEDS`.
  - _Bookmarklet capture_ — `?add=<url>` handled by the feed page; no token ever embedded in the bookmarklet.
- **M-FEAT2 — Comprehensive-product wave** (contracts sketched in the [implementation plan](./implementation-plan.md)): library organization (favorites/archive, tag browse, per-entry note), export/backup endpoint, content types (PDF via cloud `toMarkdown`; experimental YouTube transcripts), monthly reading report (digest `kind` column + monthly cron), and — deployed-only — weekly-digest **email delivery** via the `send_email` binding plus **email-in capture** via Email Routing.
- **M4 — Desktop + mobile.** PWA pass first (installability, zero store friction, **share target** for mobile capture), then wrap the same client build with Tauri 2. Client API base URL becomes configurable; API adds CORS for the Tauri origin. Store-distribution caveats noted in [ADR-0001](./adr/0001-cross-platform-web-first-tauri2.md).
- **M5 — Multi-user. Shipped 2026-09-05** ([ADR-0013](./adr/0013-google-identity-session-cookies.md)): Google sign-in + D1 session cookies replacing the bearer token and the chat WS tickets, `user_id` tenancy on every owned row (migration 0012), per-user BYOK settings, per-user Vectorize namespaces, digest/report cron fan-out per eligible user, and a 10-saves/user/UTC-day cap. Still open from the original M5 sketch: Browser-Rendering extraction, email-in capture and digest email delivery (both need a custom domain — P27). YouTube/PDF ingestion and the monthly report landed earlier, in M-FEAT2.

## 13. Verification (M1 definition of done)

1. `pnpm dev` runs Vite + local Worker (miniflare) + local D1 + local Vectorize.
2. `wrangler d1 create til`; bindings wired; migrations applied `--local` (incl. FTS5 + triggers).
3. **Settings** → enter BYOK provider + real key + CF account/gateway ids → **Test connection** returns OK. (Dev shortcut: `DirectLLMClient` may call the provider directly if no gateway exists yet.)
4. **Feed** → paste a real article URL → card goes `pending` → `ready` with a genuine takeaway/summary/tags → search finds it by a keyword → open detail → delete works (and removes its vector).
5. Paywalled / JS-heavy URL → graceful `failed` card (documents the extraction limit). Duplicate URL → 409, UI jumps to existing entry.
6. Requests without the bearer token get `401` (except `/api/health`); `PUT /api/settings` rejects partial bodies.
7. Typecheck + lint + unit tests clean (per-phase DoD commands in the [implementation plan](./implementation-plan.md)). No deploy until explicitly requested (`wrangler deploy` is a real external action needing the CF account).

## 14. Risks & mitigations

| Risk                                                                      | Mitigation                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployed Worker holds BYOK keys with weak auth → wallet-drain / key exfil | Google sign-in + D1 session cookie on every route; one settings row **per user**, so a key can only spend its own owner's credits; 10 saves/user/UTC-day; full-replace `PUT /api/settings` ([ADR-0013](./adr/0013-google-identity-session-cookies.md), [ADR-0007](./adr/0007-single-user-local-first.md))                  |
| SSRF / open proxy via ingest URL                                          | Scheme allowlist, private-host blocks, size/time caps, final-URL revalidation ([ADR-0007](./adr/0007-single-user-local-first.md))                                                                                                                                                                                          |
| AI SDK major-version churn (v4→v5→v6→v7)                                  | Exact-pin `ai@6.x`; all imports contained in `packages/core` behind `LLMClient`; `DirectLLMClient` fallback ([ADR-0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md), [0005](./adr/0005-byok-llmclient-abstraction.md))                                                                                     |
| Accidental routing through Vercel's paid gateway                          | Guardrail: explicit provider instances only, plain model strings banned ([ADR-0002](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md))                                                                                                                                                                           |
| Prompt injection via ingested content                                     | Digest path has no tools; content framed as untrusted data; M3 chat tools are read-only, args zod-clamped and results size-capped ([ADR-0005](./adr/0005-byok-llmclient-abstraction.md))                                                                                                                                   |
| Long articles exceeding provider per-minute token limits                  | Digest prompt capped at 24k chars (~6k tokens) — 48k previously failed outright on Groq's free tier                                                                                                                                                                                                                        |
| Chat WS credential visible in access logs                                 | No credential in the URL at all: the HttpOnly `til_session` cookie rides the same-origin upgrade, which retired the 60 s HMAC ticket that used to appear in logs ([ADR-0013](./adr/0013-google-identity-session-cookies.md))                                                                                               |
| Forged `id_token` (its signature is not JWKS-verified)                    | The token is only ever read from Google's token endpoint over TLS, in exchange for a code + client secret; claims (`iss`/`aud`/`exp`/`email_verified`) are validated. Any future path that accepts an `id_token` from a browser must verify against JWKS first ([ADR-0013](./adr/0013-google-identity-session-cookies.md)) |
| One user reading another's entries, digests or chats                      | `user_id` on every owned row, every query scoped, Vectorize namespaced per user; foreign ids answer `404`, not `403`, so existence never leaks; asserted by a permanent cross-tenant test matrix ([ADR-0013](./adr/0013-google-identity-session-cookies.md))                                                               |
| `nodejs_compat` re-enabled for the Agents SDK                             | Bundle 417 → 811 kB gzip, well under limits; flag is scoped to the Worker and revisitable if chat is dropped ([ADR-0003](./adr/0003-runtime-cloudflare-workers-vite-plugin.md))                                                                                                                                            |
| `waitUntil` is best-effort → stuck `pending` entries                      | Lazy stale sweep (>10 min → `failed`) + manual reingest; Cloudflare Workflows is the durable upgrade path (M2)                                                                                                                                                                                                             |
| Extraction fails (paywall/JS/bot)                                         | Fail entry gracefully + retry; Browser Rendering fallback in M-later ([ADR-0006](./adr/0006-content-extraction-to-markdown.md))                                                                                                                                                                                            |
| AI Gateway needs CF account/gateway                                       | Dev can bypass to provider-direct via `DirectLLMClient`                                                                                                                                                                                                                                                                    |
| Worker CPU/time/bundle limits, extraction cost                            | Likely a paid Workers plan; async ingest via `waitUntil`; no `nodejs_compat` keeps the bundle lean                                                                                                                                                                                                                         |
| BYOK key at rest in D1                                                    | Masked in responses; M1.5: envelope encryption or AI Gateway stored keys ([ADR-0007](./adr/0007-single-user-local-first.md))                                                                                                                                                                                               |
| Single copy of a growing knowledge base                                   | M1.5: scheduled D1 export → R2; documented manual `wrangler d1 export`                                                                                                                                                                                                                                                     |
| Embedding model change invalidates index                                  | `embedModel` recorded in vector metadata; re-embed is a batch reprocess ([ADR-0009](./adr/0009-retrieval-insight-layer.md))                                                                                                                                                                                                |

## 15. Prerequisites

Cloudflare account (D1 + AI Gateway + deploy), one provider API key (OpenAI or Anthropic), Node ≥ 20, pnpm.

## 16. Open questions

Resolved in v2: ~~Pi namespace~~ (Pi dropped — [ADR-0002 v2](./adr/0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)); ~~ingest latency~~ (`waitUntil` + polling + lazy stale sweep); ~~encrypt key in M1~~ (defer — auth + full-replace `PUT` instead; M1.5 options in [ADR-0007](./adr/0007-single-user-local-first.md)).

Still open:

- ~~Default provider/model for first run~~ — resolved at P5: first provider is **OpenAI** via CF AI Gateway; model is entered at runtime in Settings (no hardcoded default).
- AI SDK v7: evaluate after M1 ships (migration budget ~1 day; stay pinned to v6 until then).
- M2 source strategy: which free sources + whether a search API (e.g. Brave free tier) is needed — decide at M2 kickoff.
- M1.5: adopt AI Gateway gateway-stored provider keys (removes `api_key` from D1) — verify feature maturity then.
