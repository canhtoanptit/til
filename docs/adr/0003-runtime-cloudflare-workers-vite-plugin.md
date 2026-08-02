# ADR-0003: Runtime & deploy — Cloudflare Workers + `@cloudflare/vite-plugin` (single full-stack Worker)

- **Status:** Accepted (amended 2026-08-02: `nodejs_compat` dropped with Pi; Vectorize binding added)
- **Date:** 2026-08-02
- **Related:** [ADR-0001](./0001-cross-platform-web-first-tauri2.md), [ADR-0004](./0004-database-d1-drizzle.md), [ADR-0009](./0009-retrieval-insight-layer.md)

## Context

We chose to deploy on Cloudflare and to be web-first. We need to serve a React SPA and a small API, hold the BYOK key server-side, reach D1 and AI Gateway, and keep local dev simple for one developer.

## Decision

Ship a **single full-stack Cloudflare Worker** built with **`@cloudflare/vite-plugin`**:

- The Worker serves the built SPA via the **static-assets binding** (`env.ASSETS`), with `not_found_handling: "single-page-application"` for client-side routing.
- The API is **Hono**, mounted so `/api/*` hits Worker code first (`run_worker_first: ["/api/*"]`).
- Bindings: `DB` (D1), `AI` (Workers AI — `toMarkdown` + `bge-m3` embeddings), `VECTORIZE` (index `til-entries`, [ADR-0009](./0009-retrieval-insight-layer.md)), `ASSETS`; AI Gateway reached over `fetch`. Secret: `APP_TOKEN` ([ADR-0007](./0007-single-user-local-first.md)).
- Local dev: `@cloudflare/vite-plugin` runs Vite + the Worker on miniflare with a local D1.

## Alternatives considered

- **Cloudflare Pages (frontend) + separate Worker (API).** The older split. Rejected: two deploy targets and more wiring; the single-Worker + static-assets model is the current Cloudflare-recommended approach for greenfield full-stack apps.
- **A Node server (Express/Fastify) on a VM/container.** Rejected: not Cloudflare-native, loses D1/AI-Gateway ergonomics and edge deploy.

## Consequences

**Positive**
- One repo app, one `wrangler deploy`, one local dev command; SPA + API + DB co-located.
- Hono is tiny, TypeScript-native, and web-standard — fits the Worker size limit.

**Negative / caveats**
- Worker limits apply: CPU time, request duration, and bundle size (~1 MB) — informs using `waitUntil` for ingest and keeping extraction lean ([ADR-0006](./0006-content-extraction-to-markdown.md)).
- No SSR (SPA/static only) — acceptable for this app and required for the Tauri wrap ([ADR-0001](./0001-cross-platform-web-first-tauri2.md)).
- ~~`nodejs_compat` for Pi~~ — no longer needed: the AI SDK is fetch-native ([ADR-0005 v2](./0005-byok-llmclient-abstraction.md)). Keep the Worker bundle lean regardless.
