# ADR-0008: Repository — pnpm workspaces + Turborepo monorepo

- **Status:** Accepted
- **Date:** 2026-08-02
- **Related:** [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md), [ADR-0001](./0001-cross-platform-web-first-tauri2.md)

## Context

The project shares TypeScript across several units: the web client, the Worker API, the AI/domain core, the database layer, and (later) shared UI and a Tauri native shell. We want shared types, clear boundaries, and fast incremental builds — without heavyweight tooling for a solo project.

## Decision

Use a **pnpm workspaces + Turborepo** monorepo.

```
apps/web            # SPA + Worker (@cloudflare/vite-plugin)
packages/core       # domain types, ingest, LLMClient + Pi adapter
packages/db         # Drizzle schema + migrations
# later: packages/ui (shared components incl. M3 chat UI), apps/native (Tauri)
```

- pnpm workspaces for dependency management and internal package linking.
- Turborepo for task orchestration/caching (`build`, `typecheck`, `lint`, `dev`).
- A shared `tsconfig.base.json`.

## Alternatives considered

- **Single package (no workspaces).** Rejected: poor separation between UI, API, domain, and DB; harder to reuse `core`/`db` in the future Tauri app and agents.
- **Nx.** Rejected: more powerful but heavier and more opinionated than needed for a solo, few-package repo; Turborepo is lighter and sufficient.

## Consequences

**Positive**

- Shared types across client/worker/core/db; enforced module boundaries.
- Incremental, cached builds; a clean home for future `ui` and `native` packages.

**Negative / caveats**

- Monorepo tooling overhead (workspace config, Turbo pipeline).
- Care needed so Worker-bound packages stay Workers-compatible. A useful side effect of the workspace split: `ai` is a dependency of `packages/core` only, so `import from "ai"` genuinely fails to resolve inside `apps/web` — [ADR-0002](./0002-ai-stack-vercel-ai-sdk-cloudflare-ai-gateway.md)'s containment guardrail is enforced by the package boundary, not just by review.
