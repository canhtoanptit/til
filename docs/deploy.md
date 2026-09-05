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

Two kinds of credential exist at runtime, and neither lives in the repo:

- **A Google OAuth client** (`GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`), plus **`OWNER_EMAIL`** — the three Worker secrets behind sign-in ([ADR-0013](./adr/0013-google-identity-session-cookies.md)). Users sign in with their Google account and get a `til_session` cookie; every `/api/*` route except `/api/health` and the sign-in endpoints requires one. `OWNER_EMAIL` is the address that claims the pre-existing (pre-multi-user) data on its first sign-in. You create all three in step 9.
- **An LLM provider key** (OpenAI, Anthropic, or Groq) — **one per user**, entered in the app's Settings page and stored in that user's row in D1; the app never ships one. All LLM traffic (entry summaries, digests, chat) is routed through **Cloudflare AI Gateway**, which you will create in step 8, so you get logs and spend visibility for free.

Anyone with a Google account can register on your deployment and gets their own private library. Saves are capped at **10 entries per user per UTC day** (override with the `ENTRY_DAILY_LIMIT` var), which bounds what a stranger can spend of your Workers AI neurons — but each user's LLM spend is on their own provider key.

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

This applies every checked-in migration in filename order (`0000_init` through `0012_multi_user`): the core schema, the FTS5 index and its triggers, digests, the vectors table, the chats index, feeds, reviews, feedback, the library columns, content types, digest kinds, and the multi-user tables. `--remote` is the important flag — without it wrangler applies them to a local simulator, not your real database.

**Migrate before you deploy new code, not after.** The migrations are written so the _old_ code keeps working against the _new_ schema (every `user_id` column carries `DEFAULT 'owner'`, so inserts from a pre-multi-user Worker still land legally). The reverse is not true: new code against an old schema queries columns and tables that do not exist yet, and every request fails. On an **update** of a live deployment that means migrate first, then `wrangler deploy` — the order the [Updating a deployment](#updating-a-deployment) section uses.

## Step 8 — Create an AI Gateway

In the [Cloudflare dashboard](https://dash.cloudflare.com): **AI → AI Gateway → Create gateway**. Name it anything (e.g. `til`).

Write down two values — the Settings page will ask for both:

- **Account ID** — shown in the dashboard sidebar under Workers & Pages (also printed by `npx wrangler whoami`).
- **Gateway ID** — the name you just gave the gateway.

Optionally, enable **authenticated gateway** on it and create a gateway token; the app's Settings page has a field for it (`cf-aig-authorization`). Skip this on a first deploy if you want fewer moving parts — it can be added later.

## Step 9 — Create the Google OAuth client and set the auth secrets

Sign-in is a Google OIDC authorization-code flow the Worker implements itself ([ADR-0013](./adr/0013-google-identity-session-cookies.md)); it needs an OAuth client from [Google Cloud Console](https://console.cloud.google.com/).

**a. Pick or create a project**, then go to **APIs & Services → OAuth consent screen**.

- **User type: External.** ("Internal" only exists for Google Workspace organisations and would limit sign-in to your own domain.)
- Fill in the app name, your support email and a developer contact address.
- Scopes: the app asks for `openid`, `email` and `profile` only. These are **non-sensitive** scopes, so no Google verification review is required.
- **Publish the app** (**Publish app** → confirm). While it is in _Testing_, only the handful of accounts you list as test users can sign in; publishing is what makes "anyone with a Google account can register" true. With only the three basic scopes, publishing is immediate — there is nothing to submit for review.

**b. Create the client:** **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.**

- **Authorized redirect URIs** — add one per origin the app is reachable on, each ending in `/api/auth/callback`:
  ```
  http://localhost:5173/api/auth/callback
  https://til.<your-subdomain>.workers.dev/api/auth/callback
  https://<your-custom-domain>/api/auth/callback     # only if you have one
  ```
  The Worker derives its redirect URI from the origin of the incoming request, so each origin needs its own entry here — and none of them needs a config change in the repo. A missing entry surfaces as Google's `redirect_uri_mismatch` error page, never as a broken app.
- **Authorized JavaScript origins**: leave empty. The browser never talks to Google's APIs directly; only the Worker does, server-side.

Copy the **Client ID** and **Client secret**.

**c. Store the three secrets** (from `apps/web`):

```sh
npx wrangler secret put GOOGLE_CLIENT_ID       # paste the client ID
npx wrangler secret put GOOGLE_CLIENT_SECRET   # paste the client secret
npx wrangler secret put OWNER_EMAIL            # the Google address that owns the existing data
```

If the worker doesn't exist yet, wrangler offers to create a draft worker to attach the secrets to — accept.

`OWNER_EMAIL` matters even on a brand-new deployment: migration `0012_multi_user` seeds a placeholder `owner` user and assigns every pre-existing row to it, and the first **verified** Google account whose email matches `OWNER_EMAIL` (case-insensitive) claims that row and its data. Get it wrong and nothing breaks visibly — that account just lands in a fresh, empty library while your real data waits, still unclaimed, for the right address.

The app **fails closed**: with the two Google secrets unset, `/api/auth/google` and `/api/auth/callback` answer `503` and nobody can sign in; every other `/api/*` route answers `401` without a session. Setting the secrets before the first deploy means there is never a live-but-unusable window.

## Step 10 — Deploy

```sh
npx wrangler deploy
```

The output shows a bindings table — check that all seven bindings are there (`CHAT` Durable Object, `DIGEST` Workflow, `DB` D1, `VECTORIZE`, `AI`, `ASSETS`, `TIL_STACK="cloud"`), alongside the three secrets from step 9 — then the cron schedules, the workflow, and your URL:

```
Deployed til triggers
  https://til.<your-subdomain>.workers.dev
  schedule: 0 8 * * 1
  schedule: 0 9 1 * *
  workflow: til-digest
```

If a binding row is missing, you deployed a stale build — rerun step 6 and deploy again.

## Step 11 — Sign in as the owner and configure the app

1. **Open the URL and sign in first, with the `OWNER_EMAIL` account.** The login page offers **Continue with Google**; the first sign-in by that address claims the placeholder `owner` user created by migration `0012_multi_user`, and with it every entry, digest, feed, review and settings row that predates multi-user. Do this before letting anyone else register — the claim is one-shot, and a different account signing in first simply gets its own empty library (it cannot take your data), but you want your own library back before you start using the deployment.
   - Landed in an empty library? That is the `OWNER_EMAIL` mismatch, not data loss. See [Troubleshooting](#troubleshooting).
2. **Go to Settings** and fill in the LLM configuration: provider (`openai` / `anthropic` / `groq`), model name, your provider API key, your Cloudflare **Account ID** and **Gateway ID** from step 8 (and the gateway token, if you enabled authentication). Save, then use the built-in connection test.

Do this **before** pasting your first link: ingesting an entry summarizes it with your LLM, and fails with `settings not configured` until this step is done. Settings are **per user** — everyone who registers configures their own provider and key, and spends only their own credits.

### If you are upgrading an existing deployment: backfill the vectors

Only relevant when the `VECTORIZE` binding is enabled (step 5) — on a stack without it, skip this.

Vectors written before multi-user carry no namespace, and queries now run under `namespace = <your user id>`, so old vectors silently stop matching: semantic search and "related entries" degrade to keyword-only for that older material. It is never a cross-tenant leak, just a quiet loss of recall. Signed in as the owner, re-embed once:

```sh
curl -X POST -b "til_session=<your session cookie>" https://til.<your-subdomain>.workers.dev/api/entries/reembed
```

(The cookie value is in DevTools → Application → Cookies.) **Known limit:** each call scans the **200 oldest `ready` entries** — a pre-existing cap, not new here. In cloud mode `entry_vectors` is empty, so nothing is skipped as "fresh" and all 200 are genuinely re-upserted under your namespace; a library larger than that needs the call repeated as entries are re-embedded, or a follow-up keyset-paged reembed (out of scope today).

### Optional: change the daily save limit

Entry creation is capped at 10 per user per UTC day. To override, add an `ENTRY_DAILY_LIMIT` var (Workers dashboard → your Worker → Settings → Variables, or a `vars` entry in `wrangler.jsonc`) set to a positive integer as a string. A missing or nonsense value falls back to 10.

## Step 12 — Verify the deployment

Work through these in order; each one exercises a different resource.

1. **Health (no auth):**
   ```sh
   curl https://til.<your-subdomain>.workers.dev/api/health
   ```
   Expect `{"ok":true,"stack":"cloud","embedder":"ok"}`. `"embedder":"unavailable"` means the `AI` binding is still commented out — revisit step 5, rebuild, redeploy.
2. **Auth fails closed:**
   ```sh
   curl -i https://til.<your-subdomain>.workers.dev/api/entries
   ```
   Expect `401` and `{"error":{"code":"unauthorized",…}}` — no session, no data. Then sign out in the app and confirm the login page comes back.
3. **Ingest:** on the Feed page, paste an article URL. The entry should appear with a summary and takeaways (that was your LLM through the AI Gateway; you'll see the request in the gateway's dashboard logs).
4. **Semantic search:** press **⌘K / Ctrl+K** and search for a _paraphrase_ of the article — not its literal words. A hit proves Workers AI embeddings and Vectorize are wired up.
5. **Chat:** open Chat and ask about the saved entry. The agent should cite it. (The WebSocket upgrade is authenticated by the same session cookie — if chat connects, cookie auth is working end to end.)
6. **Digest:** on the Digests page press **Run now** (or wait for Monday 08:00 UTC). A digest of the default feeds should appear after ~a minute.
7. **Isolation, if you want to see it:** sign in from a private window with a second Google account. It should land in an empty library — no entries, no feeds, no settings — and opening one of your entry URLs directly should answer `404`.

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

**Keep that order.** Migrations are written so the currently-deployed code survives the new schema; new code against an old schema does not survive at all (see step 7). If an update introduces new secrets — as the multi-user release did with `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `OWNER_EMAIL` — set them before deploying too, or the app comes up unable to sign anybody in.

## Troubleshooting

| Symptom                                                        | Likely cause / fix                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every API call returns 401                                     | You are not signed in — the session cookie is missing or expired (sessions last 30 days). Sign in again. From `curl`, pass the cookie explicitly: `-b "til_session=<value from DevTools → Application → Cookies>"`; there is no header-based credential any more.                                                                                                                                           |
| Sign-in returns 503 `auth_failed`                              | `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is unset. Re-run step 9c, then redeploy is _not_ needed — secrets take effect immediately, but confirm with `npx wrangler secret list`.                                                                                                                                                                                                                        |
| Google shows `redirect_uri_mismatch`                           | The origin you opened the app on is not in the OAuth client's authorized redirect URIs, or its entry is missing the `/api/auth/callback` path. Add it exactly (step 9b), including scheme and any custom domain.                                                                                                                                                                                            |
| Signed in fine, but the library is empty and your data is gone | Almost certainly an `OWNER_EMAIL` typo: the account you used didn't match, so it got a **fresh, empty account** rather than the owner's. Your data is still there, still attached to the unclaimed `owner` user. Fix the secret (`npx wrangler secret put OWNER_EMAIL`), then sign in with the matching account — the claim only fires while `owner.google_sub` is still NULL, so it will still be waiting. |
| `/api/health` says `"embedder":"unavailable"`                  | The `ai` binding is still commented out in `wrangler.jsonc` (step 5), or you deployed a stale build (step 6). Entries ingested while the embedder was down stay unindexed — after fixing, backfill them with `curl -X POST -b "til_session=<your cookie>" https://<your-url>/api/entries/reembed`.                                                                                                          |
| Saving an entry returns 429 `rate_limited`                     | The 10-saves-per-user-per-UTC-day cap. The response's `Retry-After` header and `retryAfterSeconds` field give the seconds to the next UTC midnight; raise it with `ENTRY_DAILY_LIMIT` (step 11) if you need more.                                                                                                                                                                                           |
| `settings not configured` when adding an entry                 | Step 11 — save LLM settings first.                                                                                                                                                                                                                                                                                                                                                                          |
| Chat errors mentioning tool calls                              | Your chosen model can't call tools. Pick a tool-calling-capable model in Settings.                                                                                                                                                                                                                                                                                                                          |
| Vector dimension errors in logs                                | The Vectorize index was created with the wrong `--dimensions`. Delete and recreate it exactly as in step 4 (1024, cosine).                                                                                                                                                                                                                                                                                  |
| Wrangler targets the wrong account                             | `export CLOUDFLARE_ACCOUNT_ID=<id>` before running wrangler commands.                                                                                                                                                                                                                                                                                                                                       |
| `Authentication error [code: 10000]` on `vectorize` commands   | Your OAuth token lacks `workers:write` (the scope that gates Vectorize — `ai:write` is not enough). Re-run the login command from step 2 exactly as written.                                                                                                                                                                                                                                                |
| Deploy succeeds but the app shows old config                   | Rebuild before deploying — wrangler reads the generated `dist/til/wrangler.json`, which only updates on `pnpm build`.                                                                                                                                                                                                                                                                                       |

## Notes for self-hosters

- **Multi-user since 2026-09-05** ([ADR-0013](./adr/0013-google-identity-session-cookies.md)). Anyone with a Google account can register on your deployment; each gets their own entries, feeds, reviews, chats and settings row (their own provider key, their own spend), isolated by a `user_id` column on every owned row and by a per-user Vectorize namespace. You cannot read another user's data through the app — only through the D1 console. If you want a private instance, either leave the OAuth consent screen in _Testing_ and list only your own address as a test user, or put Cloudflare Access in front of the Worker.
- **Sign-out is best-effort on the client.** The button always ends the local session and returns you to the login page; if the `POST /api/auth/logout` that deletes the D1 row fails (offline, worker error), the row survives until its 30-day TTL. To force-revoke a session, delete the row from the `sessions` table.
- **Costs.** Your LLM provider bills summaries/digests/chat (watch it in the AI Gateway dashboard). Workers AI bills embedding neurons beyond the free daily allocation. Everything else sits comfortably in free-plan quotas at personal scale.
- **Local development keeps working** exactly as before this guide (verified after enabling the bindings): `pnpm dev` runs with `TIL_STACK=local` from `.dev.vars` (see [`.dev.vars.example`](../apps/web/.dev.vars.example)), which never touches the `AI`/`VECTORIZE` bindings, so the dev server starts cleanly even with them declared.
- **Digest sources** are currently the hardcoded default RSS feeds; making them editable in Settings is on the roadmap (P19).
