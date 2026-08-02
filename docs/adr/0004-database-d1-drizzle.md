# ADR-0004: Database — Cloudflare D1 (SQLite) + Drizzle ORM

- **Status:** Proposed
- **Date:** 2026-08-02
- **Related:** [ADR-0003](./0003-runtime-cloudflare-workers-vite-plugin.md), [ADR-0007](./0007-single-user-local-first.md)

## Context

We need durable storage for entries and settings. The workload is single-user and small; data is co-located with a Cloudflare Worker. We want typed schema and a clean migration workflow. The brief allowed "SQLite or Postgres".

## Decision

Use **Cloudflare D1** (serverless SQLite) with **Drizzle ORM** and **drizzle-kit** migrations.

- Schema and migrations live in `packages/db`.
- Workflow: `drizzle-kit generate` (SQL migration files) → `wrangler d1 migrations apply til` (local and remote).
- Tables per the [tech design](../tech-design.md#7-data-model-d1): `entries`, `settings`.

## Alternatives considered

- **Postgres** (e.g. Neon via Hyperdrive). More powerful (concurrency, rich types), but heavier and unnecessary at single-user scale, and not as frictionless on Workers. Rejected for now; revisit if M5 multi-user demands it.
- **Raw SQL over the D1 client.** Rejected: loses compile-time type safety and a managed migration story.
- **Prisma (D1 adapter).** Rejected: heavier runtime on Workers than Drizzle for little benefit here.

## Consequences

**Positive**
- Native to Cloudflare; zero extra infra; local D1 in dev via miniflare.
- Typed schema end-to-end; straightforward migrations.

**Negative / caveats**
- SQLite semantics (fine for this app's access patterns — no heavy concurrent writes).
- D1 size/row and query limits to keep in mind as the feed grows.
- A migration discipline to maintain (generate + apply on every schema change).
