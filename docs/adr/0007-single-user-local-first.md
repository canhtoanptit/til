# ADR-0007: Single-user, local-first; BYOK key at rest in own D1

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0004](./0004-database-d1-drizzle.md), [ADR-0002](./0002-ai-stack-pi-cloudflare-ai-gateway.md)

## Context

TIL starts as a personal experiment and tool. The user configures a BYOK provider key in-app. Building multi-tenant auth and key management up front would be premature and would slow the path to a working product.

## Decision

Ship **single-user, local-first**:

- No authentication in M1.
- A single `settings` row holds the BYOK provider config and API key.
- The **API key is stored in the user's own D1** and is **never returned unmasked** from the API (masked on `GET /api/settings`).
- All data lives in the user's own Cloudflare account.

## Alternatives considered

- **Multi-user SaaS from day one** (auth, per-user API keys, multi-tenant D1). Rejected as premature: significant infrastructure for a solo experiment; deferred to M5 where it becomes a deliberate refactor (add `user_id` scoping, an auth provider, and per-user key storage).

## Consequences

**Positive**
- Simplest possible model; fastest path to value; no auth surface to secure in M1.

**Negative / caveats**
- The BYOK key sits **at rest in the user's own D1** (plaintext unless we add encryption). Acceptable for a personal instance the user controls; optional envelope encryption (key from Worker secret) can be added without schema-breaking changes.
- Going multi-user later requires scoping every table and every query by user — designed for, but not free.
