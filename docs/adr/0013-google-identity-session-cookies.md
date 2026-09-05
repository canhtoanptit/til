# ADR-0013: Multi-user via Google sign-in and D1 session cookies; per-user tenancy; 10 saves/day

- **Status:** Accepted (2026-09-05) — supersedes the auth mechanism of [ADR-0007](./0007-single-user-local-first.md)
- **Date:** 2026-09-05
- **Related:** [ADR-0007](./0007-single-user-local-first.md), [ADR-0004](./0004-database-d1-drizzle.md), [ADR-0009](./0009-retrieval-insight-layer.md), [ADR-0010](./0010-dual-mode-local-cloud-stack.md)

## Context

ADR-0007 shipped a single-tenant instance behind one shared bearer token (`APP_TOKEN`), and explicitly deferred multi-user to "M5 as a deliberate refactor (add `user_id` scoping, an auth provider, per-user key storage)". This ADR is that refactor: anyone with a Google account can register, everyone gets the whole feature set (entries, search, tags, settings/BYOK, digests, feeds, reviews, feedback, chat, export), and no user can observe another's data.

A shared token cannot express any of that. It carries no identity, so there is nothing to scope a query by; it is one secret for every visitor, so revoking one person means rotating for all; and it has to be handed out by hand, which is not a registration flow. The chat WebSocket had already forced a second credential on top of it — a 60 s HMAC ticket — because browsers cannot set headers on a WS handshake.

The instance is also already deployed with real data, all of it the owner's, so whatever lands has to give those rows a home rather than orphan them.

## Decision

Replace the bearer token with **Google sign-in and server-side sessions**, and scope every row to a user.

- **Google OIDC authorization-code flow, hand-implemented** — no new npm dependency, roughly 300 lines across `worker/google-oauth.ts`, `worker/identity.ts`, `worker/session.ts`, `worker/routes/auth.ts`. Endpoints: `GET /api/auth/google` (redirect to Google), `GET /api/auth/callback`, `GET /api/auth/me`, `POST /api/auth/logout`, `POST /api/auth/dev-login`. The redirect URI is **derived from the request origin** (`${origin}/api/auth/callback`), never configured: one worker answers on localhost, workers.dev and any custom domain, and each origin needs its own URI registered with Google but not its own env var here.
- **The `id_token` is decoded, not signature-verified.** It is fetched by the Worker directly from Google's token endpoint over TLS, in exchange for a code and the client secret — the channel is the trust anchor, so there is no unauthenticated hop for a forged token to enter through. Claims _are_ validated: `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`}, `aud === GOOGLE_CLIENT_ID`, `exp` in the future, `email_verified === true`, non-empty `sub`/`email`. Accepted risk and its boundary are in Consequences.
- **CSRF on the callback is a double-submit state cookie**: a random `state` in `til_oauth_state` (HttpOnly, `Path=/api/auth`, 10 min), compared constant-time against the `state` query param and **burned unconditionally**, whatever the outcome.
- **Sessions live in D1** (`sessions` table, FK to `users`, cascade). The cookie `til_session` carries an opaque 256-bit hex id — HttpOnly, `SameSite=Lax`, `Path=/`, `Secure` iff the request is https. Fixed **30-day TTL, no sliding renewal**; expired rows are swept opportunistically on the read that finds them. Hono middleware resolves the cookie to a `SessionUser` on every `/api/*` request except `GET /api/health` and the `/api/auth/*` entry points; anything else without a live session is `401 unauthorized`.
- **The WebSocket upgrade is authenticated by the same cookie.** Cookies ride a same-origin upgrade request, which is what the ticket scheme existed to work around, so `POST /api/chat/ticket` and the whole HMAC ticket mechanism are deleted. `APP_TOKEN` is retired with no back-door.
- **`OWNER_EMAIL` claims the existing data.** Migration `0012_multi_user` seeds a placeholder user `id='owner'` (`google_sub` NULL, sentinel email `owner@placeholder.invalid`) and backfills every pre-existing row to it. The first verified Google account whose email matches `OWNER_EMAIL` (case-insensitive) takes that row over — one claim only, because the claim requires `google_sub` to still be NULL. Everyone else gets a fresh `crypto.randomUUID()` user.
- **`POST /api/auth/dev-login` exists only when `TIL_STACK=local`** — it 404s otherwise, before body validation, so a deployed worker does not admit the route exists. It routes through the same user upsert with identity `sub = "dev:<email>"`, which means a local dev-login as the `OWNER_EMAIL` address claims the owner row exactly like the real flow.
- **Tenancy is a `user_id` column** on `entries, digests, feeds, reviews, feedback, chats, settings` (migration 0012). `digest_items` and `entry_vectors` get none — they hang off a parented row and are scoped by joining it. Uniqueness moves from global to per-user: `(user_id, canonical_url)` and `(user_id, url)`, so two people may save the same link. `settings` gains `UNIQUE(user_id)`: **BYOK is per user**, and ingest reads the settings of the entry's owner, not of whoever triggered the work. The Drizzle columns deliberately omit the SQL `DEFAULT 'owner'` so that an insert site which forgets its user fails to compile rather than silently writing into the owner's tenant.
- **Vector scoping is a Vectorize namespace** (`namespace = userId` on upsert and query) rather than a metadata filter: namespaces need no index-creation step, and a namespace cannot be forgotten at query time the way a filter can. In local mode `D1VectorStore` joins `entries` on `user_id` instead.
- **The digest cron fans out per user** — weekly for users with a settings row and ≥1 enabled feed, the monthly report for users with ≥1 ready entry in the window; one user's failure logs and moves on.
- **Entry creation is capped at 10 per user per UTC day** (`ENTRY_DAILY_LIMIT` overrides), enforced only on `POST /api/entries`, after the 409 duplicate check: `429` with code `rate_limited`, a `Retry-After` header and `retryAfterSeconds` in the body. Error precedence is 400 invalid > 409 duplicate > 429 limit.

## Alternatives considered

- **Keep the bearer token, add users beside it.** Rejected: a token that identifies nobody cannot scope a query, and self-service registration means handing every new visitor a secret by hand. It also keeps the WS ticket alive forever.
- **Cloudflare Access in front of the Worker.** Rejected again, for the reason ADR-0007 gave and one more: it authenticates at the edge but hands the app a header, not a durable per-user record to key data on; it breaks the M4 Tauri/mobile clients and `curl` ergonomics; and free-tier seat limits make "anyone can register" the one thing it is bad at. Still available as an optional extra layer for a private instance.
- **Full JWKS signature verification of the `id_token`.** Deferred, not rejected — see Consequences. It buys nothing on the code-flow path taken here, and costs a key-fetch, a cache and a rotation story.
- **Lucia, Auth.js, or a hosted IdP (Clerk/Auth0/WorkOS).** Rejected on dependency weight and fit: a Workers-compatible auth library is a large surface with its own schema and upgrade cadence for what is one provider, one flow and one cookie; a hosted IdP puts a third party between the user and their own data, which is the opposite of this project's posture. ~300 lines that this repo owns and tests is the cheaper end of the trade.
- **JWT sessions instead of D1 rows.** Rejected: opaque ids in a table make sign-out and revocation real (delete the row) instead of a best-effort wait for expiry, and the session read is a single indexed lookup on a database every request already touches.

## Consequences

**Positive**

- Registration is self-service and costs the operator nothing per user; the app never sees a password.
- Identity is a first-class column, so isolation is enforced in the queries themselves and is testable — the cross-tenant matrix asserts it per route rather than trusting a middleware.
- One credential, everywhere. The cookie authenticates REST, the export download and the chat WS upgrade alike, so no credential ever appears in a URL or an access log.
- Sign-out is a server-side delete, not an expiry wait; per-user BYOK means one user's key spends only their own credits.
- Existing data survives the transition intact and gets a real owner on the first sign-in.

**Negative / caveats**

- **The `id_token` signature is unverified.** This is safe only as long as the token comes from the direct token-endpoint exchange; if a future path ever accepts an `id_token` from the browser (Google One Tap, a mobile client), that path **must** verify against Google's JWKS first. Recorded here so the constraint travels with the code.
- Three secrets to manage instead of one (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAIL`), and the OAuth client must list a redirect URI per origin. The auth endpoints fail closed with `503 auth_failed` until the first two are set.
- A wrong `OWNER_EMAIL` is a silent-looking failure: the mismatched account signs in successfully and lands in a **fresh, empty** library while the owner's data waits, still unclaimed, for the right address.
- No sliding renewal — everyone signs in again every 30 days.
- The rate-limit count is not transactional: concurrent saves can land 11, and delete-then-re-add frees quota. Accepted for v1.
- Legacy Vectorize vectors carry no namespace and silently stop matching until the owner runs `POST /api/entries/reembed` (degraded semantic search, never a cross-tenant leak). That backfill still caps at the oldest 200 ready entries per call.
- Google is now a hard dependency of the deployed app's front door; a local stack stays fully usable via dev-login.
