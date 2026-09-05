# TIL — Today I Learned

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020.svg)](https://developers.cloudflare.com/workers/)

**Paste a link, and an LLM turns it into something you'll actually remember.**

TIL is a self-hosted reading companion. Save a URL and it extracts the article, writes a short summary, pulls out the single most interesting takeaway, tags it, and suggests a follow-up question worth exploring. Over time you get a searchable, organizable library of what you've learned — plus a weekly digest of interesting things from around the web, and a monthly report on your own reading.

You run it in your own Cloudflare account. Sign-in is Google, and every user gets their own library, their own settings and their own LLM API key — nobody, including the person hosting it, reads anyone else's data through the app ([ADR-0013](./docs/adr/0013-google-identity-session-cookies.md)). No third party holds your data or your key.

> **Status:** working software, active development, and deployed — capture (M1), the weekly digest (M2), the chat agent (M3), the eval harness, the UI refresh, and both feature waves (review queue, related entries, feedback, personalized ranking, library organization, export, extra content types, monthly report) are complete and verified against real data — as is multi-user (M5): Google sign-in, per-user isolation and a daily save cap. It also still runs entirely locally.

---

## Features

- **Capture** — paste a URL, get a structured digest: title, ~150-word summary, the key takeaway, 3–6 tags, and a follow-up question.
- **Search** — full-text search across everything you've saved (SQLite FTS5), fused with semantic search when an embedder is available.
- **Organize your library** — favorite, archive and annotate entries, and browse by tag. Archived reading stays searchable but out of the way.
- **Related entries** — every entry links to its nearest neighbours by meaning, so old saves resurface when you read something adjacent.
- **Review queue** — turn takeaways into spaced repetition (SM-2-lite). The queue shows the follow-up question and hides the answer until you grade yourself.
- **Weekly digest** — a scheduled job gathers candidates from Hacker News, Lobsters, arXiv and your own RSS feeds, ranks them by recency, popularity and cross-source corroboration, then has an LLM write up the most interesting ones. Ranking is **personalized** against what you've actually saved.
- **Monthly reading report** — a second scheduled job writes up *your* month: what you read, what stuck, what you kept coming back to. It is structurally incapable of citing a URL you never saved.
- **Chat with your reading** — ask *"what have I saved about CSS?"* or *"what did I read most this month?"*. A Durable-Object agent answers using three **read-only** tools: hybrid semantic + keyword search, single-entry lookup, and reading statistics. Answers cite the entries they came from, and 👍/👎 feedback is recorded against the answer.
- **More than articles** — PDFs are extracted server-side via Workers AI `toMarkdown` (no OCR, so scanned documents say so). *YouTube transcripts: experimental* — the keyless caption path is frequently blocked from datacenter IPs, and every failure explains itself rather than pretending the video had no words.
- **Export** — one streamed request gives you the whole library as JSON for restore, or as a single readable markdown bundle. Your provider key is deliberately left out.
- **Runs offline** — one env var switches between local open-source adapters (Readability extraction, Ollama embeddings, cosine search in SQLite) and the Cloudflare services (Workers AI, Vectorize). Same embedding model either way, so local search behaves like production.
- **Bring your own key** — OpenAI, Anthropic or Groq, routed through *your* Cloudflare AI Gateway for caching, rate limiting and cost visibility. The key never reaches the browser.
- **Graceful failure** — paywalls, bot protection and JS-heavy pages are surfaced as failed cards with a retry, never as hangs.
- **Prompt-injection aware** — article and candidate text is always framed as untrusted data; the extraction path has no tools.

### Coming next

- **Desktop & mobile** — PWA first, then a Tauri 2 shell around the same build.
- **Email** — weekly digest delivered by email, and capture-by-forwarding a link. Deferred: Cloudflare Email Routing needs a custom domain, which this deployment doesn't have yet.

---

## Architecture

One full-stack Cloudflare Worker serves the React SPA *and* the API, so there's a single deploy target and a single local dev command.

```
┌─────────────────────────────────────────────────────────────────┐
│                     Cloudflare Worker ("til")                     │
│  React + Vite SPA ──(static assets binding)                       │
│        │  fetch /api/*  (til_session cookie)                       │
│        ▼                                                          │
│   Hono API ────────► D1 (SQLite) [entries, settings, digests, FTS] │
│        │                                                          │
│        ├──► fetch(url)          (SSRF-guarded)                    │
│        ├──► Extractor           (HTML → markdown)                 │
│        ├──► LLMClient ──► your CF AI Gateway ──► OpenAI/Anthropic/Groq │
│        └──► Embedder ──► vector index                             │
│                                                                   │
│   DigestWorkflow (cron, durable steps: plan → fetch → rank → write) │
└─────────────────────────────────────────────────────────────────┘
```

Every external capability sits behind a small interface (`LLMClient`, `Extractor`, `Embedder`, `VectorStore`), which keeps the LLM SDK out of the app layer and makes the stack swappable.

**Tech stack:** TypeScript · React 19 + Vite + Tailwind 4 · Hono on Cloudflare Workers · D1 + Drizzle ORM · Cloudflare Workflows · Vercel AI SDK · pnpm workspaces + Turborepo · Vitest.

Design rationale lives in [`docs/`](./docs/README.md) — a technical design document plus 13 ADRs covering each load-bearing decision and the alternatives that were rejected. Deploying to your own account is a step-by-step guide: [docs/deploy.md](./docs/deploy.md).

---

## Getting started

### Prerequisites

- **Node.js ≥ 20** and **pnpm 10**
- An API key from **one** of: OpenAI, Anthropic, or Groq (Groq has a usable free tier)
- A **Cloudflare account** with an [AI Gateway](https://developers.cloudflare.com/ai-gateway/) — the gateway itself is free; you'll need your account ID and gateway ID

### Install and run

```bash
git clone https://github.com/canhtoanptit/til.git
cd til
pnpm install

# local env for the Worker (OWNER_EMAIL, TIL_STACK, embedder settings)
cp apps/web/.dev.vars.example apps/web/.dev.vars     # defaults are fine locally

# create the local D1 database
pnpm --filter @til/web exec wrangler d1 migrations apply til --local

pnpm dev                                # http://localhost:5173
```

Then in the browser:

1. **Sign in.** Locally the login page offers a dev-login form (it exists only when `TIL_STACK=local`) — use the `OWNER_EMAIL` value from `.dev.vars` (`dev@example.com` by default) so you own the seeded data. **Continue with Google** also works once you've set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ([docs/deploy.md](./docs/deploy.md) walks through creating the OAuth client).
2. Go to **Settings** → pick your provider, model and API key, add your Cloudflare account ID and gateway ID → **Save** → **Test connection**.
   - **Model choice matters.** The chat agent needs reliable tool calling and the digest needs strict JSON. On Groq, `openai/gpt-oss-20b` handles both; `llama-3.3-70b-versatile` streams prose fine but emits tool calls Groq's own validator rejects, so chat questions that need a search will fail.
3. Go to **Feed** → paste an article URL and watch it become a digest.
4. Optionally visit **Digests → Run now** to generate a digest of interesting things from the web.

> If your AI Gateway has **Authenticated Gateway** enabled, also fill in the gateway token field — otherwise requests are rejected with a 401 that never appears in your gateway logs.

### Optional: semantic search offline

Everything above works without this — search just stays keyword-only, and `GET /api/health` reports `embedder: "unavailable"`. To enable semantic search locally:

```bash
ollama pull bge-m3                                    # ~1.2 GB, the same model production uses
# restart dev, then backfill vectors for what you already saved:
curl -X POST -b "til_session=<your session id>" http://localhost:5173/api/entries/reembed
```

> `curl` needs the same session cookie the browser holds: copy the `til_session` value from DevTools → Application → Cookies, or mint one with
> `curl -i -X POST -H 'content-type: application/json' -d '{"email":"dev@example.com"}' http://localhost:5173/api/auth/dev-login` and read it off the `Set-Cookie` header.

The alternative is `TIL_STACK=cloud`, which uses Workers AI and Vectorize instead — no local model, but it needs a `CLOUDFLARE_API_TOKEN` and those bindings uncommented in `wrangler.jsonc`. See [ADR-0010](./docs/adr/0010-dual-mode-local-cloud-stack.md).

### Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite + local Worker (miniflare) + local D1 |
| `pnpm build` | Build all packages and the Worker bundle |
| `pnpm typecheck` | TypeScript across every package |
| `pnpm test` | Vitest across every package |
| `pnpm lint` | ESLint |
| `pnpm format` | Prettier |

---

## Project structure

```
apps/web/            # the Cloudflare Worker: React SPA (src/client) + Hono API (src/worker)
packages/core/       # domain layer: LLMClient/Extractor seams, prompts, source adapters, ranking
packages/db/         # Drizzle schema + D1 migrations (incl. FTS5 triggers)
packages/evals/      # offline eval harness: datasets, metrics and runners for retrieval and chat
docs/                # technical design, ADRs, implementation plan
```

---

## Configuration

| Where | Setting | Notes |
|---|---|---|
| `apps/web/.dev.vars` locally, Worker secrets in production | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAIL` | Google sign-in. The first two come from an OAuth client you create ([docs/deploy.md](./docs/deploy.md) step 9); without them the `/api/auth/*` endpoints answer `503` and nobody can sign in. `OWNER_EMAIL` is the account that claims the pre-existing (pre-multi-user) data on its first sign-in — case-insensitive, and it works for the local dev-login too. Optional: `ENTRY_DAILY_LIMIT` overrides the 10-saves-per-user-per-day cap. |
| Settings page (stored in D1) | provider, model, API key, CF account ID, CF gateway ID, optional gateway token | The key is masked in every response and never sent to the browser. It can be omitted on save to keep the stored one, unless you change provider or gateway routing. |
| `apps/web/.dev.vars` / `wrangler.jsonc` `vars` | `TIL_STACK` | `local` (default) or `cloud` — selects the adapter set per [ADR-0010](./docs/adr/0010-dual-mode-local-cloud-stack.md). `OLLAMA_BASE_URL` overrides the local embedder endpoint. |
| `wrangler.jsonc` | bindings, weekly cron, chat Durable Object | The Workers AI and Vectorize bindings are commented out by default: neither has a local emulator, and enabling them makes local dev require a Cloudflare API token. `nodejs_compat` is on for the Agents SDK. |

---

## Development notes

- **Local-first.** Everything except Workers AI and Vectorize runs offline — D1, Workflows, cron and Durable Objects all emulate locally. Extraction falls back to a local implementation when the AI binding is absent, so the full capture → digest → search flow works with no cloud resources beyond the AI Gateway your key routes through.
- **Contract-first.** Interfaces (database schema, API shapes, core seams) are frozen in [`docs/implementation-plan.md`](./docs/implementation-plan.md) before implementation, which is what lets independent pieces be built in parallel without breaking each other.
- **Tests don't touch the network.** Every provider and source adapter is tested against a mocked `fetch`; database tests run real migrations against in-memory SQLite.

---

## Security

- Each user's provider API key lives only in your own D1 database, in that user's own settings row, and is never returned unmasked. Storage is plaintext in the current milestone — envelope encryption and Cloudflare AI Gateway stored keys are the planned upgrades.
- Every `/api/*` route except `/api/health` and the sign-in endpoints needs a live session; the `til_session` cookie is HttpOnly, `SameSite=Lax`, `Secure` over https, opaque (256 random bits) and backed by a D1 row, so signing out revokes it server-side rather than waiting for it to expire.
- Data is isolated per user by a `user_id` column on every owned row, with per-user Vectorize namespaces for semantic search. Another user's id answers `404`, not `403`, so the app never confirms that someone else's entry exists. A permanent cross-tenant test matrix asserts this route by route.
- Chat runs over a WebSocket, and browsers cannot set headers on a WS handshake — but cookies ride a same-origin upgrade, so the session cookie authorises it and no credential ever appears in a URL or an access log.
- Saving is capped at 10 entries per user per UTC day, so a stranger with an account cannot burn through your Workers AI or extraction budget.
- Chat tools are strictly read-only and cannot modify or delete anything. Tool arguments are validated and clamped, and results are size-capped before reaching the model.
- URL ingestion blocks non-HTTP(S) schemes and loopback, private, link-local and metadata addresses, with size, timeout and redirect limits.

Found a security issue? Please open an issue describing the impact — don't include working exploit details for anything affecting others.

---

## Contributing

This is a personal project, but issues and pull requests are welcome. Before opening a PR:

1. Read the relevant ADR in [`docs/`](./docs/README.md) — most design questions already have a recorded answer and a list of rejected alternatives.
2. Run `pnpm typecheck && pnpm lint && pnpm test` (all green, no skipped tests).
3. Keep architectural changes to a separate ADR-updating commit, so the reasoning stays reviewable.

---

## License

[Apache License 2.0](./LICENSE) © canhtoanptit

## Acknowledgements

The digest pipeline's fan-out → rank → synthesize pattern is modelled on [`mvanhorn/last30days-skill`](https://github.com/mvanhorn/last30days-skill), reimplemented to run inside a Worker. Candidate sources are the keyless public APIs of [Hacker News (via Algolia)](https://hn.algolia.com/api), [Lobsters](https://lobste.rs) and [arXiv](https://arxiv.org/help/api) — thanks for keeping them open.
