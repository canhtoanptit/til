# Deploying TIL to Cloudflare — step by step

This guide takes you from a fresh clone to a working deployment on your own Cloudflare account. No prior Cloudflare experience is assumed; every command is copy-pasteable. Budget roughly 30 minutes.

## What you are deploying

TIL ships as **one Cloudflare Worker** that serves both the React SPA and the API, so there is a single deploy target. Around it sit five Cloudflare resources, all declared in [`apps/web/wrangler.jsonc`](../apps/web/wrangler.jsonc):

| Resource        | Name / binding              | What it does                                          |
| --------------- | --------------------------- | ----------------------------------------------------- |
| D1 database     | `til` / `DB`                | Entries, digests, chats, settings, FTS5 keyword index |
| Vectorize index | `til-entries` / `VECTORIZE` | Embedding vectors for semantic search                 |
| Workers AI      | `AI`                        | `bge-m3` embeddings + `toMarkdown` page extraction    |
| Durable Object  | `TilChatAgent` / `CHAT`     | The chat agent (SQLite-backed)                        |
| Workflow + cron | `til-digest` / `DIGEST`     | The weekly digest run (Mondays 08:00 UTC)             |

Two credentials exist at runtime, and neither lives in the repo:

- **`APP_TOKEN`** — a bearer token you invent. It guards every `/api/*` route except `/api/health`, and the UI asks for it on first load. Anyone who has it can spend your LLM credits, so treat it like a password.
- **Your LLM provider key** (OpenAI, Anthropic, or Groq) — entered later in the app's Settings page and stored in D1. All LLM traffic (entry summaries, digests, chat) is routed through **Cloudflare AI Gateway**, which you will create in step 8, so you get logs and spend visibility for free.

Embeddings run on Workers AI (billed in "neurons"; there is a free daily allocation). D1, Vectorize, SQLite-backed Durable Objects, Workflows, and cron triggers are all available on the Workers Free plan at personal scale as of this writing — but verify current limits against [Cloudflare's pricing docs](https://developers.cloudflare.com/workers/platform/pricing/) before relying on that.

## Prerequisites

- **Node.js ≥ 20** and **pnpm 10** (`corepack enable` gives you the right pnpm from the repo's `packageManager` field).
- A **Cloudflare account** ([sign up free](https://dash.cloudflare.com/sign-up)).
- An **API key for one LLM provider**: OpenAI, Anthropic, or Groq. The chat feature requires a model that supports **tool calling** — most current mid-tier models do; the app shows a readable error if yours doesn't.

## Step 1 — Clone, install, sanity-check

```sh
git clone <your-fork-or-this-repo> til
cd til
pnpm install
pnpm test
```

All tests should pass before you touch anything. If they don't, stop and fix that first — nothing below will improve it.

## Step 2 — Authenticate wrangler

Wrangler is Cloudflare's CLI; it is already a dev dependency of the web app, so run it with `npx` from `apps/web` (every wrangler command below assumes you are in `apps/web`):

```sh
cd apps/web
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write d1:write ai:write
npx wrangler whoami    # confirms the account and the granted scopes
```

`wrangler login` opens a browser page where you must click **Allow** — denying (or closing the tab) fails the login. A bare `npx wrangler login` works too, but requests ~25 scopes including email sending and containers; the `--scopes` list above is the verified minimum for everything in this guide. Two scope gotchas learned the hard way: `workers:write` is required even though it looks redundant next to `workers_scripts:write` — it is what gates the **Vectorize** commands (there is no narrower Vectorize scope, and `ai:write` alone gets `Authentication error [code: 10000]` in step 4); and don't add `offline_access` yourself — wrangler appends it automatically and rejects it as invalid if passed explicitly.

`whoami` will warn that "Wrangler is missing some expected Oauth scopes" — that is just the difference from the default full set, and is expected.

On a **headless machine** (no browser), skip OAuth and use an API token instead: create one at dash.cloudflare.com → My Profile → API Tokens with Workers Scripts:Edit, D1:Edit, Vectorize:Edit, Workers AI:Read, Account Settings:Read, User Details:Read, then `export CLOUDFLARE_API_TOKEN=<token>`.

If your login has access to **multiple Cloudflare accounts**, pin the one you want before continuing:

```sh
export CLOUDFLARE_ACCOUNT_ID=<the account id>
```

## Step 3 — Create the D1 database

```sh
npx wrangler d1 create til
```

Wrangler offers to add the config snippet to `wrangler.jsonc` on your behalf — **decline**: its generated snippet uses `"binding": "til"`, but the app's code expects `"binding": "DB"`, which the checked-in config already declares. Only the id needs to change.

The output contains a `database_id` (a UUID). Open `apps/web/wrangler.jsonc` and replace the placeholder with it:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "til",
    "database_id": "<paste the UUID here>",   // was "local-placeholder"
    "migrations_dir": "../../packages/db/migrations",
  },
],
```

## Step 4 — Create the Vectorize index

```sh
npx wrangler vectorize create til-entries --dimensions=1024 --metric=cosine
```

The parameters are not optional preferences: the app embeds with `bge-m3`, which produces **1024-dimensional** vectors, and the code asserts that dimension on every upsert and query. The name `til-entries` must match the `index_name` in `wrangler.jsonc` (it already does).

## Step 5 — Enable the cloud bindings in wrangler.jsonc

At the bottom of `apps/web/wrangler.jsonc` two bindings are commented out (they have no local emulation, so they stay off for local dev). Uncomment both:

```jsonc
"ai": { "binding": "AI" },
"vectorize": [{ "binding": "VECTORIZE", "index_name": "til-entries" }]
```

You do **not** need to touch `TIL_STACK`: the checked-in config already sets `"TIL_STACK": "cloud"` for deploys, which selects the Workers AI extractor/embedder and the Vectorize store. (Local dev overrides it back to `local` via `.dev.vars`, so your laptop workflow is unchanged.)

## Step 6 — Build

```sh
pnpm build   # from apps/web; runs `vite build`
```

This builds the SPA **and** the worker, and regenerates `dist/til/wrangler.json` from your edited `wrangler.jsonc`. Build before the next two steps — wrangler in this project reads the _generated_ config (via `.wrangler/deploy/config.json`), so migrating or deploying against a stale build would use your old, placeholder config.

## Step 7 — Apply the database migrations to remote D1

```sh
npx wrangler d1 migrations apply til --remote
```

This applies the five checked-in migrations (`0000_init` through `0004_chats`): the core schema, the FTS5 index and its triggers, digests, the vectors table, and the chats index. `--remote` is the important flag — without it wrangler applies them to a local simulator, not your real database.

## Step 8 — Create an AI Gateway

In the [Cloudflare dashboard](https://dash.cloudflare.com): **AI → AI Gateway → Create gateway**. Name it anything (e.g. `til`).

Write down two values — the Settings page will ask for both:

- **Account ID** — shown in the dashboard sidebar under Workers & Pages (also printed by `npx wrangler whoami`).
- **Gateway ID** — the name you just gave the gateway.

Optionally, enable **authenticated gateway** on it and create a gateway token; the app's Settings page has a field for it (`cf-aig-authorization`). Skip this on a first deploy if you want fewer moving parts — it can be added later.

## Step 9 — Set the APP_TOKEN secret

Invent a strong token and store it as a Worker secret:

```sh
openssl rand -base64 32          # generate one; save it in your password manager
npx wrangler secret put APP_TOKEN   # paste it at the prompt
```

If the worker doesn't exist yet, wrangler offers to create a draft worker to attach the secret to — accept. (Order is forgiving here: the API **fails closed**, answering 401 to everything except `/api/health` until the secret exists. But setting it before the first deploy means there is never an unusable-but-live window.)

## Step 10 — Deploy

```sh
npx wrangler deploy
```

The output shows a bindings table — check that all seven rows are there (`CHAT` Durable Object, `DIGEST` Workflow, `DB` D1, `VECTORIZE`, `AI`, `ASSETS`, `TIL_STACK="cloud"`) — then the cron schedule, the workflow, and your URL:

```
Deployed til triggers
  https://til.<your-subdomain>.workers.dev
  schedule: 0 8 * * 1
  workflow: til-digest
```

If a binding row is missing, you deployed a stale build — rerun step 6 and deploy again.

## Step 11 — First-run configuration in the app

1. **Open the URL.** The token gate appears — paste your `APP_TOKEN`.
2. **Go to Settings** and fill in the LLM configuration: provider (`openai` / `anthropic` / `groq`), model name, your provider API key, your Cloudflare **Account ID** and **Gateway ID** from step 8 (and the gateway token, if you enabled authentication). Save, then use the built-in connection test.

Do this **before** pasting your first link: ingesting an entry summarizes it with your LLM, and fails with `settings not configured` until this step is done.

## Step 12 — Verify the deployment

Work through these in order; each one exercises a different resource.

1. **Health (no auth):**
   ```sh
   curl https://til.<your-subdomain>.workers.dev/api/health
   ```
   Expect `{"ok":true,"stack":"cloud","embedder":"ok"}`. `"embedder":"unavailable"` means the `AI` binding is still commented out — revisit step 5, rebuild, redeploy.
2. **Ingest:** on the Feed page, paste an article URL. The entry should appear with a summary and takeaways (that was your LLM through the AI Gateway; you'll see the request in the gateway's dashboard logs).
3. **Semantic search:** press **⌘K / Ctrl+K** and search for a _paraphrase_ of the article — not its literal words. A hit proves Workers AI embeddings and Vectorize are wired up.
4. **Chat:** open Chat and ask about the saved entry. The agent should cite it.
5. **Digest:** on the Digests page press **Run now** (or wait for Monday 08:00 UTC). A digest of the default feeds should appear after ~a minute.

## Updating a deployment

```sh
git pull
pnpm install
pnpm test
cd apps/web
pnpm build
npx wrangler d1 migrations apply til --remote   # picks up any new migration files; no-op otherwise
npx wrangler deploy
```

## Troubleshooting

| Symptom                                                      | Likely cause / fix                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every API call returns 401                                   | `APP_TOKEN` secret missing or you typed a different token at the gate. Re-run step 9, then use **sign out** in the nav to re-enter the token (it's stored in your browser's localStorage).                                                                                                                |
| `/api/health` says `"embedder":"unavailable"`                | The `ai` binding is still commented out in `wrangler.jsonc` (step 5), or you deployed a stale build (step 6). Entries ingested while the embedder was down stay unindexed — after fixing, backfill them with `curl -X POST -H "Authorization: Bearer $APP_TOKEN" https://<your-url>/api/entries/reembed`. |
| `settings not configured` when adding an entry               | Step 11 — save LLM settings first.                                                                                                                                                                                                                                                                        |
| Chat errors mentioning tool calls                            | Your chosen model can't call tools. Pick a tool-calling-capable model in Settings.                                                                                                                                                                                                                        |
| Vector dimension errors in logs                              | The Vectorize index was created with the wrong `--dimensions`. Delete and recreate it exactly as in step 4 (1024, cosine).                                                                                                                                                                                |
| Wrangler targets the wrong account                           | `export CLOUDFLARE_ACCOUNT_ID=<id>` before running wrangler commands.                                                                                                                                                                                                                                     |
| `Authentication error [code: 10000]` on `vectorize` commands | Your OAuth token lacks `workers:write` (the scope that gates Vectorize — `ai:write` is not enough). Re-run the login command from step 2 exactly as written.                                                                                                                                              |
| Deploy succeeds but the app shows old config                 | Rebuild before deploying — wrangler reads the generated `dist/til/wrangler.json`, which only updates on `pnpm build`.                                                                                                                                                                                     |

## Notes for self-hosters

- **Single-user by design.** There is one `APP_TOKEN` and one settings row; multi-user is an explicit non-goal of this project.
- **Costs.** Your LLM provider bills summaries/digests/chat (watch it in the AI Gateway dashboard). Workers AI bills embedding neurons beyond the free daily allocation. Everything else sits comfortably in free-plan quotas at personal scale.
- **Local development keeps working** exactly as before this guide (verified after enabling the bindings): `pnpm dev` runs with `TIL_STACK=local` from `.dev.vars` (see [`.dev.vars.example`](../apps/web/.dev.vars.example)), which never touches the `AI`/`VECTORIZE` bindings, so the dev server starts cleanly even with them declared.
- **Digest sources** are currently the hardcoded default RSS feeds; making them editable in Settings is on the roadmap (P19).
