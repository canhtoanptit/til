# ADR-0007: Single-user, single-tenant self-hosted; auth required before deploy; BYOK key at rest in own D1

- **Status:** Accepted (v2, 2026-08-02)
- **Date:** 2026-08-02
- **Related:** [ADR-0004](./0004-database-d1-drizzle.md), [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)
- **History:** v1 said "local-first, no authentication in M1". Review found that framing inaccurate and the no-auth stance dangerous: a deployed Worker is public internet, data lives in D1 (not on-device), and unauthenticated endpoints holding a BYOK key are a **wallet-drain** (`POST /api/entries` burns LLM credits per call) and **key-exfiltration** vector (repointing gateway settings around the stored key).

## Context

TIL starts as a personal experiment: one user, running their own instance in their own Cloudflare account. Multi-tenant auth and key management up front would be premature — but "no auth" only holds while the app runs exclusively on `localhost`. The moment `wrangler deploy` happens, every endpoint is internet-reachable and `workers.dev` URLs get scanned constantly.

## Decision

Ship **single-user, single-tenant, self-hosted** (the term "local-first" is retired — data lives in the user's own D1, not on-device):

- **No auth in local dev** (miniflare). **Auth is mandatory before the first deploy**: a single bearer token (`APP_TOKEN` Worker secret) checked by Hono middleware on all `/api/*` routes except `GET /api/health`. The SPA stores the token (entered once on a gate screen) in `localStorage` and sends `Authorization: Bearer …`. Optionally layer **Cloudflare Access** in front at deploy time (free tier) for defense in depth.
- A single `settings` row holds the BYOK provider config and API key. The key is **never returned unmasked** (masked to last 4 on `GET /api/settings`).
- **`PUT /api/settings` is full-replace only** — no partial update can repoint `cf_account_id`/`cf_gateway_id` while keeping the stored key (closes the key-exfil-via-gateway-redirect path).
- **Ingest fetches are SSRF-guarded**: http/https only, no loopback/private/link-local hosts, response size and time caps, final-URL revalidation after redirects.
- The key sits at rest in the user's own D1, plaintext, in M1 — accepted for a personal instance the user controls. M1.5 upgrade options (no schema break): envelope encryption with a key from a Worker secret, or Cloudflare AI Gateway's gateway-stored provider keys (key leaves the app entirely).
- All data lives in the user's own Cloudflare account. A periodic **D1 export** (cron → R2, or documented manual `wrangler d1 export`) is the backup story — this becomes a personal knowledge base; one copy is zero copies.

## Alternatives considered

- **Multi-user SaaS from day one** (auth provider, per-user keys, multi-tenant D1). Rejected as premature; deferred to M5 as a deliberate refactor (add `user_id` scoping, an auth provider, per-user key storage).
- **No auth even when deployed** (v1). Rejected — see History.
- **Cloudflare Access only, no app token.** Simpler (zero app code) but breaks the M4 Tauri/mobile clients and local `curl` ergonomics; the bearer token works identically everywhere. Access is kept as an optional extra layer, not the primary gate.

## Consequences

**Positive**

- Still the simplest viable model; ~15 lines of middleware buys a closed attack surface.
- Threat model is now honest: the deploy boundary, not the feature set, is what triggers the auth requirement.
- Token auth already fits the M4 remote-client model ([ADR-0001](./0001-cross-platform-web-first-tauri2.md)).

**Negative / caveats**

- A token to manage (rotate by `wrangler secret put APP_TOKEN` + re-enter in UI).
- Key-at-rest in D1 remains a consciously accepted risk until M1.5; D1 exports/console show it in plaintext.
- Going multi-user later still requires scoping every table and query by user — designed for, but not free.
