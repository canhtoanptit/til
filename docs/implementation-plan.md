# TIL — Implementation Plan & Agent Orchestration Playbook

- **Status:** Active
- **Date:** 2026-08-02
- **Related:** [tech-design.md](./tech-design.md), ADRs 0001–0010
- **Audience:** the orchestrator (a TPM-role agent or human) who dispatches implementation agents, and the implementation agents themselves.

---

## 1. Operating model

**Contract-first decomposition.** Agents don't need whole-system context because every coupling point (schema, interfaces, API shapes, binding names, conventions) is **frozen in §2** before any code exists. Each phase brief in §4 is self-contained: it embeds or names the exact contracts it needs.

**Orchestrator rules:**

1. Dispatch **one agent per phase brief**. The agent prompt = the brief section + the contract sections it references (paste them in verbatim). Nothing else — no conversation history, no other briefs.
2. Agents report done → **orchestrator independently runs the phase DoD commands** before marking the phase complete. Trust but verify; an agent's summary is not evidence.
3. **Contracts are law.** An agent that needs to deviate from a contract must stop and report — the orchestrator updates §2 first (single source of truth), then re-briefs affected phases. No silent drift.
4. Parallelism: only run phases in parallel when §3 shows no dependency edge. Parallel agents must not touch the same files.
5. Integration bugs found in P5 become **patch briefs** (scoped like phase briefs), not free-form fixes.
6. After each phase, record in §6 (changelog): date, agent, deviations, chosen dependency versions (from lockfile).
7. Never `wrangler deploy`, never create remote CF resources, never commit/push unless the repo owner explicitly asks.
8. **Model policy:** implementation agents run on **Opus by default** (owner's call 2026-08-02: quality over token cost; requested `opus-4-8`). The Agent tool takes tier names, so dispatch with `model: "opus"` — it resolves to the newest Opus available in the harness. Downshifting a trivial task (e.g. P6 runbook prep) requires owner approval.

**Agent ground rules (include in every brief):**

- You are implementing one bounded package/area of a pnpm monorepo. Everything you need is in this brief. **Do not** explore the rest of the repo beyond your scoped paths + reading root configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `turbo.json`).
- Do not modify files outside your scope list.
- TypeScript strict; ESM only; no `any` unless justified with a one-line comment.
- Default to zero code comments; comment only non-obvious WHY.
- If a contract seems wrong or incomplete, **stop and report** — do not improvise a new interface.
- Finish by reporting: what you built, DoD command output, any deviations proposed (not applied).

---

## 2. Frozen contracts

### C1 — Workspace

- Packages: `@til/web` (`apps/web`), `@til/core` (`packages/core`), `@til/db` (`packages/db`).
- Tooling: Node ≥ 20, pnpm ≥ 9 workspaces, Turborepo 2 (`build`, `typecheck`, `lint`, `test`, `dev`), shared `tsconfig.base.json` (strict, `moduleResolution: bundler`, ESM).
- Tests: vitest per package. Lint: eslint 9 flat config + prettier defaults.
- Dependency versions: **exact-pin `ai` (v6.x) and provider packages**; others use caret + lockfile. P0 records all chosen versions in §6.

### C2 — Worker config & bindings (`apps/web/wrangler.jsonc`)

Binding names are contractual; exact plugin wiring follows current `@cloudflare/vite-plugin` docs.

```jsonc
{
  "name": "til",
  "main": "src/worker/index.ts",
  "compatibility_date": "2026-07-01",
  // P13 amendment: nodejs_compat IS required — the Agents SDK statically imports
  // node:async_hooks / node:diagnostics_channel and dev won't boot without it.
  "compatibility_flags": ["nodejs_compat"],
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"],
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "til",
      "database_id": "local-placeholder",
      "migrations_dir": "../../packages/db/migrations",
    },
  ],
  "ai": { "binding": "AI" },
  "vectorize": [{ "binding": "VECTORIZE", "index_name": "til-entries" }],
}
```

> **P0 amendment (accepted):** the `ai` and `vectorize` bindings are **commented out** in the scaffold with `// P3: enable` notes — neither has local emulation, and `vite dev` refuses to start a remote proxy session without `CLOUDFLARE_API_TOKEN`. P3 must re-enable them and either export `CLOUDFLARE_API_TOKEN` (or `wrangler login`) for local dev, or inject stub `AI`/`VECTORIZE` implementations in tests/dev. `Env` in `env.ts` already declares both, so no type changes are needed when re-enabling.

```ts
// apps/web/src/worker/env.ts
export interface Env {
  DB: D1Database;
  AI: Ai;
  VECTORIZE: VectorizeIndex;
  ASSETS: Fetcher;
  APP_TOKEN: string; // secret; local dev: .dev.vars → APP_TOKEN=dev-token
}
```

`.dev.vars.example` committed with `APP_TOKEN=dev-token`. `.dev.vars` gitignored.

### C3 — Database schema (`packages/db`)

```ts
// packages/db/src/schema.ts  (drizzle-orm/sqlite-core)
export const entries = sqliteTable(
  "entries",
  {
    id: text("id").primaryKey(), // crypto.randomUUID()
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url").notNull(),
    title: text("title"),
    sourceDomain: text("source_domain"),
    contentMarkdown: text("content_markdown"),
    summary: text("summary"),
    takeaway: text("takeaway"),
    question: text("question"),
    tags: text("tags").notNull().default("[]"), // JSON string[]
    status: text("status").notNull().default("pending"), // 'pending' | 'ready' | 'failed'
    error: text("error"),
    createdAt: integer("created_at").notNull(), // epoch ms
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("entries_canonical_url_uq").on(t.canonicalUrl),
    index("entries_status_idx").on(t.status),
    index("entries_created_at_idx").on(t.createdAt),
  ],
);

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(), // always 1
  provider: text("provider").notNull(), // 'openai' | 'anthropic' | 'groq' (text column — enum enforced by zod, no migration on additions)
  model: text("model").notNull(),
  apiKey: text("api_key").notNull(),
  cfAccountId: text("cf_account_id").notNull(),
  cfGatewayId: text("cf_gateway_id").notNull(),
  cfAigToken: text("cf_aig_token"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
```

Hand-written migration (after the drizzle-generated one), FTS5 external-content table + sync triggers:

```sql
CREATE VIRTUAL TABLE entries_fts USING fts5(
  title, summary, takeaway, tags, content_markdown,
  content='entries', content_rowid='rowid'
);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, title, summary, takeaway, tags, content_markdown)
  VALUES (new.rowid, new.title, new.summary, new.takeaway, new.tags, new.content_markdown);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, takeaway, tags, content_markdown)
  VALUES ('delete', old.rowid, old.title, old.summary, old.takeaway, old.tags, old.content_markdown);
END;
CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, title, summary, takeaway, tags, content_markdown)
  VALUES ('delete', old.rowid, old.title, old.summary, old.takeaway, old.tags, old.content_markdown);
  INSERT INTO entries_fts(rowid, title, summary, takeaway, tags, content_markdown)
  VALUES (new.rowid, new.title, new.summary, new.takeaway, new.tags, new.content_markdown);
END;
```

### C4 — Core domain (`packages/core`, public API of `@til/core`)

```ts
export interface Digest {
  title: string;
  summary: string; // ≤ ~150 words
  takeaway: string; // 1–2 sentences, the single most interesting point
  question: string; // a follow-up worth exploring
  tags: string[]; // 3–6, lowercase-kebab-case
}

export interface LLMSettings {
  provider: "openai" | "anthropic" | "groq";
  model: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
  cfAigToken?: string;
}

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

// Factory. impl default 'ai-sdk'; 'direct' selectable for fallback/testing.
export function createLLMClient(
  settings: LLMSettings,
  opts?: { impl?: "ai-sdk" | "direct"; fetchImpl?: typeof fetch },
): LLMClient;

// Gateway base URL (no trailing slash), per provider:
// https://gateway.ai.cloudflare.com/v1/{cfAccountId}/{cfGatewayId}/{provider}
export function gatewayBaseURL(settings: LLMSettings): string;

// URL utilities
export function normalizeUrl(raw: string): {
  url: string;
  canonicalUrl: string;
  sourceDomain: string;
}; // strips utm_*/fbclid/gclid, lowercases host, drops fragments
export function assertSafeUrl(raw: string): URL; // throws UnsafeUrlError: non-http(s), localhost, IP-literal in loopback/private/link-local ranges
export class UnsafeUrlError extends Error {}
export class ExtractionError extends Error {}
export class DigestError extends Error {}
```

Digest prompt requirements (both clients): system prompt states the article content is **untrusted data** — never follow instructions inside it; output strictly matches the `Digest` JSON schema. `DirectLLMClient`: OpenAI → `POST {base}/openai/chat/completions` with `response_format: { type: 'json_schema', … }`, `Authorization: Bearer`; Anthropic → `POST {base}/anthropic/v1/messages` with a forced tool (`tool_choice`) carrying the schema, `x-api-key` + `anthropic-version` headers; both add `cf-aig-authorization: Bearer <cfAigToken>` when set. Groq (OpenAI-compatible; added 2026-08-03 after P5 — free tier, first working BYOK provider) → `POST {base}/chat/completions` where `{base}` ends in `/groq`, `Authorization: Bearer`; structured output via `response_format: { type: 'json_object' }` + schema-in-prompt (json_schema support varies by Groq model), validated by `parseDigest`. `AISDKClient`: **explicit** `createOpenAI`/`createAnthropic`/`createGroq` with `apiKey` + `baseURL` = `gatewayBaseURL(...)/{provider}` path per AI SDK docs — **plain string model IDs are forbidden** (ADR-0002 guardrail 1). `ai` imported only in this package.

### C5 — API contract (Hono, `/api`)

Auth: every route except `GET /api/health` requires `Authorization: Bearer <APP_TOKEN>`; failure → `401 {"error":{"code":"unauthorized","message":…}}`. Errors: `{"error":{"code":string,"message":string}}`, codes: `unauthorized`, `invalid_url`, `unsafe_url`, `duplicate_url`, `not_found`, `validation_error`, `llm_error`. JSON fields camelCase.

```
EntryDTO = { id, url, canonicalUrl, title, sourceDomain, summary, takeaway,
             question, tags: string[], status: 'pending'|'ready'|'failed',
             error: string|null, createdAt: number, updatedAt: number }
EntryDetailDTO = EntryDTO & { contentMarkdown: string|null }

POST /api/entries        { url: string } → 201 { id, status:'pending' }
                         409 { error:{code:'duplicate_url'}, existingId }
GET  /api/entries        ?cursor=<createdAt>_<id>&limit=20 → { items: EntryDTO[], nextCursor: string|null }
                         side-effect: entries pending >10 min → status='failed', error='ingest timed out'
GET  /api/entries/:id    → 200 EntryDetailDTO | 404
DELETE /api/entries/:id  → 204 (also VECTORIZE.deleteByIds([id]))
POST /api/entries/:id/reingest → 202 { id, status:'pending' }
GET  /api/search         ?q=<text>&limit=20 → { items: EntryDTO[] }   // FTS5 MATCH, rank order; sanitize q into a quoted phrase/terms
GET  /api/settings       → 200 { provider, model, apiKeyMasked, cfAccountId, cfGatewayId, hasAigToken: boolean } | 404 if unset
PUT  /api/settings       { provider, model, apiKey?, cfAccountId, cfGatewayId, cfAigToken? } → 200
                         apiKey OMITTABLE only when provider+cfAccountId+cfGatewayId match the stored row
                         (keeps stored key); required on first save or any routing change → else 422
                         validation_error. Missing provider/model/cfAccountId/cfGatewayId → 422. (ADR-0007 v2)
POST /api/settings/test  → 200 { ok: boolean, detail?: string }
GET  /api/health         → 200 { ok: true }        // no auth
```

### C6 — Retrieval conventions (ADR-0009)

- Embedding model: `@cf/baai/bge-m3` via `env.AI.run(...)`, 1024-dim (consult Workers AI docs for exact request/response shape at implementation time).
- Embedded text: `` `${title}\n${takeaway}\n${summary}\nTags: ${tags.join(', ')}` ``.
- Vectorize index `til-entries`, cosine; vector id = entry id; metadata `{ domain: string, createdAt: number, embedModel: 'bge-m3' }`.
- Upsert when entry → `ready`; delete on entry delete; delete+upsert on reingest. Embedding failure does **not** fail the entry (log, leave un-indexed).

### C7 — Frontend conventions

- React 19 + Vite, React Router (routes: `/` feed, `/entries/:id`, `/settings`), TanStack Query v5, Tailwind v4.
- `src/client/api.ts` is the **only** fetch layer; typed to C5; reads token from `localStorage['til:token']`; on 401 clears it and shows the token gate. Base URL from `import.meta.env.VITE_API_BASE ?? ''` (Tauri later).
- Poll entry detail every 2 s while `status === 'pending'` (TanStack `refetchInterval`), stop otherwise.

---

## 3. Phase map (M1)

```
P0 scaffold ──► P1 db ────┐
        │                 ├──► P3 worker API ──► P5 integration ──► P6 deploy (M1.5, human+agent)
        └────► P2 core ───┘         ▲
        └────► P4 frontend ─────────┘   (P4 parallel with P1/P2/P3; builds against C5 only)
```

| Phase | Scope                                 | Parallel with | Est. size        |
| ----- | ------------------------------------- | ------------- | ---------------- |
| P0    | Repo scaffold + Worker/SPA skeleton   | —             | S                |
| P1    | `@til/db` schema + migrations + FTS   | P2, P4        | S                |
| P2    | `@til/core` domain + both LLM clients | P1, P4        | M                |
| P3    | Worker API + ingest pipeline          | P4            | M                |
| P4    | React SPA                             | P1, P2, P3    | M                |
| P5    | Integration + TDR §13 verification    | — (needs all) | S–M              |
| P6    | M1.5 deploy hardening                 | —             | S (mostly human) |

---

## 4. Agent briefs — M1

> Orchestrator: paste the referenced contract sections verbatim into each prompt, plus the **Agent ground rules** from §1.

### P0 — Scaffold

**Mission:** bootstrap the monorepo so every later phase lands in a working skeleton.
**Contracts:** C1, C2.
**Scope:** root (`package.json`, `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json`, eslint/prettier config), `apps/web/*`, empty `packages/core` + `packages/db` stubs (name + tsconfig + src/index.ts placeholder), `.dev.vars.example`.
**Steps:** pnpm workspace + turbo pipeline; `apps/web` with `@cloudflare/vite-plugin` (React SPA at `src/client`, Worker at `src/worker`); `wrangler.jsonc` per C2 (Vectorize binding may be commented until P3 if local dev complains — note it); Hono app in the Worker serving `GET /api/health` → `{ok:true}` (no auth yet) and `env.ASSETS` fallback; minimal `src/client` React page rendering "TIL" and fetching `/api/health`.
**Out of scope:** schema, core logic, auth, any other route.
**DoD:** `pnpm install && pnpm build && pnpm typecheck && pnpm lint` clean; `pnpm dev` serves `/` (React page shows health OK) and `/api/health`. Report chosen dependency versions.

### P1 — Database package (`@til/db`)

**Mission:** typed schema + migrations, including the FTS layer.
**Contracts:** C1, C3.
**Scope:** `packages/db/**` only.
**Steps:** implement C3 schema with drizzle-orm; `drizzle-kit generate` → migration into `packages/db/migrations/`; hand-write the FTS5 migration exactly per C3; export schema + a `Db` helper type (`drizzle(d1)` wrapper) from `src/index.ts`; vitest using `better-sqlite3` (dev-dep): apply all migration SQL in order to an in-memory DB, assert (a) unique `canonical_url` violation throws, (b) FTS insert/update/delete triggers keep `entries_fts` in sync, (c) `MATCH` finds a seeded row by a takeaway keyword.
**Out of scope:** anything in `apps/web`; no D1/wrangler calls (tests run on plain SQLite).
**DoD:** `pnpm --filter @til/db build && pnpm --filter @til/db typecheck && pnpm --filter @til/db test` clean.

### P2 — Core package (`@til/core`)

**Mission:** the domain layer — both `LLMClient` implementations, URL safety, prompt.
**Contracts:** C1, C4 (+ gateway URL shape from TDR §10).
**Scope:** `packages/core/**` only.
**Steps (order matters — the learning artifact):**

1. Types, errors, `gatewayBaseURL`, `normalizeUrl`, `assertSafeUrl` (+ exhaustive unit tests: tracker stripping, IPv4/IPv6 private ranges, localhost, schemes).
2. **`DirectLLMClient` first**: raw `fetch`, both provider dialects per C4, strict parse into `Digest` (validate: all fields present, tags 3–6 array of strings) → `DigestError` on mismatch.
3. `AISDKClient`: `ai` v6 + `@ai-sdk/openai` + `@ai-sdk/anthropic` (exact-pinned), **explicit provider instances only** (grep-check: no plain string model IDs), structured output via the current v6 API (`generateObject` is deprecated — prefer the Output API per the pinned version's docs).
4. `createLLMClient` factory; shared digest prompt (content-is-untrusted-data clause per C4).
5. Tests: mock `fetchImpl`; golden request assertions per provider (URL, headers, body schema) and response parsing for both clients; `ping()` behavior on 401/timeout.
   **Out of scope:** embeddings (Worker-side, P3); anything outside `packages/core`.
   **DoD:** `pnpm --filter @til/core build && typecheck && test` clean; `grep -rn "from 'ai'" apps/ packages/db` returns nothing (SDK contained in core).

### P3 — Worker API (`apps/web/src/worker`)

**Mission:** the full C5 API + ingest pipeline over the P1/P2 packages.
**Contracts:** C2, C5, C6 (+ pipeline spec = TDR §9, paste it).
**Scope:** `apps/web/src/worker/**`; may add deps to `apps/web/package.json` (`hono`, `zod`, `@hono/zod-validator`, workspace deps `@til/core` `@til/db`).
**Steps:** bearer-auth middleware (constant-time compare vs `env.APP_TOKEN`; `/api/health` exempt); zod-validate all bodies/queries; routes per C5 exactly (409 duplicate via unique-index catch or pre-select; lazy stale sweep in list handler; full-replace settings; masked GET); ingest per TDR §9 in `ctx.waitUntil` — `assertSafeUrl` → guarded fetch (UA header, `AbortSignal.timeout(15_000)`, 5 MB cap, content-type must be HTML/text, re-`assertSafeUrl(response.url)`) → `Extractor` impl wrapping `env.AI.toMarkdown` → `createLLMClient(settings).digest(...)` → update row → C6 embed+upsert (non-fatal on failure); search route: sanitized FTS5 `MATCH` joined back to `entries` by rowid, rank order.
**Structure for testability:** route handlers take injected deps `{ db, llmFactory, extractor, vectorize, now }`; vitest covers auth (401/200), duplicate → 409, stale sweep, settings masking + full-replace 422, search join — with stubbed deps (no miniflare required; optional `@cloudflare/vitest-pool-workers` if low-friction).
**Out of scope:** `src/client/**`, `packages/**` internals (report deviations instead of editing).
**DoD:** `pnpm --filter @til/web build && typecheck && test` clean; `curl` transcript in report: health 200 unauth'd, entries 401 unauth'd, 201 → poll → (LLM unavailable locally → entry `failed` with error is acceptable), settings PUT/GET masked.

### P4 — Frontend (`apps/web/src/client`)

**Mission:** the M1 UI, built strictly against C5 (backend may not exist yet — do not call anything not in C5).
**Contracts:** C5, C7 (+ UI spec = TDR §11, paste it).
**Scope:** `apps/web/src/client/**`; may add client deps to `apps/web/package.json`.
**Steps:** `api.ts` typed client per C7 (single fetch layer, token handling, 401 → gate); token gate screen; feed (add-link with optimistic pending card + 409 → navigate to existing; cards; empty state; search box hitting `/api/search`; retry on failed); detail route (all digest fields, collapsible markdown, reingest/delete); settings form (password field, masked display, test-connection button with result states); loading/error states throughout; poll per C7.
**Out of scope:** `src/worker/**`; no invented endpoints; no state libraries beyond TanStack Query.
**DoD:** `pnpm --filter @til/web build && typecheck` clean (worker tests from P3 may coexist; don't break them); component smoke test optional. Report any C5 gaps discovered (as contract-change requests, not code).

### P5 — Integration & M1 verification

**Mission:** make the assembled system pass **TDR §13** end-to-end (paste §13 into the brief).
**Contracts:** all of §2 (read-only); TDR §13.
**Scope:** whole repo, **smallest possible diffs** — this phase fixes seams, it does not redesign. Contract deviations still require orchestrator sign-off.
**Steps:** `pnpm install && pnpm dev`; apply migrations `--local`; walk §13 items 1–2 and 4–7 with a real article URL; item 3 needs the repo owner's BYOK key + gateway ids — coordinate via the orchestrator (dev shortcut: `DirectLLMClient` provider-direct is acceptable if no gateway exists). Exercise: duplicate URL, garbage URL, unsafe URL (`http://169.254.169.254/`), paywalled URL, deletion removing the vector (assert via a second search/query), stale-pending sweep (temporarily shrink the threshold in a test, not in code).
**DoD:** every §13 item checked with evidence (command output / screenshots via dev server); full-suite `pnpm build && pnpm typecheck && pnpm lint && pnpm test` clean; punch list of anything deferred.

### P6 — M1.5 deploy hardening (human + agent)

**Mission:** first real deploy, safely. **Human actions** (repo owner): `wrangler d1 create til`, `wrangler vectorize create til-entries --dimensions=1024 --metric=cosine`, create AI Gateway, `wrangler secret put APP_TOKEN`, and the final `wrangler deploy` — the agent prepares configs/scripts and a runbook but **never executes deploy or resource creation**.
**Agent scope:** wire real `database_id`; production checklist; scheduled D1 export → R2 (cron trigger + tiny handler) if approved; smoke-test script (`curl` suite against the deployed URL); optional CF Access notes; evaluate AI Gateway gateway-stored keys (TDR §16).
**DoD:** deployed URL passes the smoke suite incl. 401-without-token; owner confirms feed golden path in production.

---

## 5. M2–M4 outline briefs (finalize after M1 retro)

### M2 — digest pipeline (kickoff decisions made 2026-08-03: keyless sources; Cloudflare Workflows)

**Source availability check (2026-08-03, binding):** Reddit **deprecated unauthenticated `.json` in May 2026** (403) and OAuth is closed to personal scripts — Reddit is OUT, and its RSS may close next. Verified-live keyless sources: **HN via Algolia** (`https://hn.algolia.com/api/v1/search_by_date`, no key, 10k req/hr/IP, supports `numericFilters=points>N`), **Lobsters** (`/hottest.json`, `/newest.json`), **arXiv** (Atom API), **RSS/Atom** (user-supplied feeds). Workflows confirmed to have full local support (`wrangler workflows … --local`, free plan OK).

#### C8 — `digests` schema (`packages/db`)

```ts
digests: { id text pk, runAt integer, windowDays integer, status text('pending'|'ready'|'failed'),
           title text, intro text, error text, createdAt integer, updatedAt integer }
digestItems: { id text pk, digestId text → digests.id (cascade), rank integer, title text,
               url text, sourceName text, sourceDomain text, score real, why text,
               evidence text /* JSON: [{url,sourceName,title}] */, createdAt integer }
// indexes: digests(runAt desc); digestItems(digestId, rank)
```

#### C9 — source adapter interface (`packages/core`)

```ts
export interface Candidate {
  url: string;
  title: string;
  sourceName: string; // 'hn' | 'lobsters' | 'arxiv' | 'rss:<host>'
  publishedAt: number; // epoch ms
  popularity?: number; // upvotes/points when the source exposes it
  snippet?: string;
}
export interface SourceAdapter {
  readonly name: string;
  fetchCandidates(opts: {
    windowDays: number;
    limit: number;
    fetchImpl?: typeof fetch;
  }): Promise<Candidate[]>;
}
// Pure ranking helpers (no I/O): clusterCandidates(cands) → EvidenceCluster[] (dedupe by canonical URL +
// title similarity; merge cross-source hits), scoreClusters(clusters, opts) → ranked, recency+popularity+
// cross-source-corroboration weighted. Adapters MUST be individually failure-isolated by the caller.
```

#### C10 — Workflow + API

```
Workflow binding DIGEST (class DigestWorkflow, wrangler workflows entry), cron: 0 8 * * 1 (weekly Mon 08:00 UTC)
steps: plan(windowDays) → fetchSource(name) ×N (parallel, per-step retry, failures isolated)
      → cluster+score (pure) → synthesize(topK via LLMClient) → persist(digests + digestItems)
GET  /api/digests            ?limit=20 → { items: DigestSummaryDTO[] }
GET  /api/digests/:id        → DigestDetailDTO (digest + ordered items)
POST /api/digests/run        → 202 { id } (manual trigger; same Workflow)
DELETE /api/digests/:id      → 204
DigestSummaryDTO = { id, runAt, windowDays, status, title, intro, itemCount, error }
DigestDetailDTO  = DigestSummaryDTO & { items: { rank, title, url, sourceName, sourceDomain, score, why, evidence }[] }
```

Auth + error envelope identical to C5. Synthesis prompt reuses the untrusted-content rule from C4 (candidate titles/snippets are untrusted data).

#### C11 — digest synthesis (extends the `LLMClient` seam; `packages/core`)

The worker must not import `ai` directly (ADR-0002 guardrail 3), so synthesis is a new method on the existing seam:

```ts
export interface SynthesisInput {
  // one per ranked cluster, already scored
  canonicalUrl: string;
  title: string;
  sources: string[];
  publishedAt: number;
  score: number;
  snippet?: string;
}
export interface DigestItemDraft {
  canonicalUrl: string;
  title: string;
  why: string;
}
export interface DigestSynthesis {
  title: string;
  intro: string;
  items: DigestItemDraft[];
}

export interface LLMClient {
  digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest>;
  synthesizeDigest(
    inputs: SynthesisInput[],
    opts: { windowDays: number; maxItems: number },
  ): Promise<DigestSynthesis>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}
```

Validation (both impls): `items` are dropped unless their `canonicalUrl` appears in `inputs` (no hallucinated links), `items.length ≤ maxItems`, order is the LLM's ranking; malformed output → `DigestError`. Candidate titles/snippets are **untrusted data** — same clause as C4. Groq keeps json_object + schema-in-prompt (P5.3).

**Briefs:** _P9a synthesis_ (`packages/core`: C11 on both clients) ∥ _P7 sources_ (`packages/core`: 4 adapters + clustering/scoring + tests, no CF deps) ∥ _P8 digests schema_ (`packages/db`: C8 migration + types). Then _P9 workflow+API_ (`apps/web`: Workflow class, cron, routes per C10) ∥ _P10 digest UI_ (`apps/web/src/client`: list + detail, manual run button, against C10).

### M3 — chat agent

Kickoff decisions (2026-08-04): local embeddings via **Ollama bge-m3**; chat served by the **Agents SDK on Durable Objects**. Mode selection per **[ADR-0010](./adr/0010-dual-mode-local-cloud-stack.md)**.

**Verified facts (2026-08-04):** `AIChatAgent` ships in **`@cloudflare/ai-chat`** and extends `Agent` from **`agents`**; it is a protocol adapter — you override `onChatMessage`, call `streamText` yourself, wire tools, return a `Response`. Peer ranges `ai@^6 || ^7` and `@ai-sdk/react@^3 || ^4`; **we are on `ai@6.0.240`, so pair with `@ai-sdk/react@^3`**. Ollama embeddings: `POST http://localhost:11434/api/embed` `{model, input: string|string[]}` → `{model, embeddings: number[][]}`, already **L2-normalized** (legacy `/api/embeddings` takes `prompt` → `{embedding}` — do not use).

#### C12 — mode selector + retrieval seams

```ts
// packages/core — interfaces + the Ollama adapter (pure fetch, edge-safe)
export type StackMode = "local" | "cloud";
export interface Embedder {
  // MUST return L2-normalized vectors (ADR-0010)
  readonly model: string; // e.g. 'bge-m3'
  readonly dimensions: number; // 1024
  embed(texts: string[]): Promise<number[][]>;
}
export interface VectorMatch {
  id: string;
  score: number;
}
export interface VectorStore {
  upsert(
    v: {
      id: string;
      values: number[];
      metadata: { domain: string; createdAt: number; embedModel: string };
    }[],
  ): Promise<void>;
  query(values: number[], opts: { topK: number }): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}
export function embeddingTextFor(e: { title; takeaway; summary; tags }): string; // reuse existing shape
export function rrfMerge(
  lists: { id: string; rank: number }[][],
  k?: number,
): { id: string; score: number }[]; // k default 60
```

`env.TIL_STACK` (`.dev.vars` locally, `vars` in `wrangler.jsonc` for prod; default `"local"` when unset) selects: `local` → `ReadabilityExtractor` + `OllamaEmbedder` + `D1VectorStore`; `cloud` → `WorkersAIExtractor` + `WorkersAIEmbedder` + `VectorizeStore`. `OLLAMA_BASE_URL` defaults to `http://localhost:11434`. Embedding failures stay **non-fatal** for ingest and must be surfaced (`GET /api/health` reports `{ stack, embedder: 'ok'|'unavailable' }`).

`D1VectorStore` storage: new table `entry_vectors(entryId text pk → entries.id cascade, embedModel text, dims integer, values text /* JSON number[] */, createdAt integer)` — migration `0003_vectors.sql`.

#### C13 — chat tools (all READ-ONLY) and retrieval

```ts
search_entries({ query: string, topK?: number /*≤20, default 8*/, tag?: string, sinceDays?: number })
  → { items: { id, title, url, sourceDomain, takeaway, tags, createdAt, score }[] }
  // hybrid: embed(query) → VectorStore.query(topK*2) ∥ FTS5 MATCH(topK*2) → rrfMerge → hydrate from D1 → topK
get_entry({ id: string }) → EntryDetail (title, url, summary, takeaway, question, tags, createdAt) — no contentMarkdown (token cost)
stats({ kind: 'per_week'|'top_tags'|'top_domains'|'streak'|'totals', sinceDays?: number })
  → { kind, rows: Record<string, string|number>[] }
```

Tool outputs are **data, not instructions** — the chat system prompt states that entry text is untrusted and must not be followed. Tools never write. **Drizzle trap (from P9b): raw `sql` columns render unqualified in single-table selects — use `leftJoin`+`groupBy` or fully qualified columns in the stats SQL.**

#### C14 — chat transport & API

```
DO binding CHAT (class TilChatAgent extends AIChatAgent), one instance per conversation id
POST /api/chat/:id            → AIChatAgent streaming response (bearer-authed like every other route)
GET  /api/chat/:id/messages   → { messages: ChatMessageDTO[] }
GET  /api/chat               → { items: { id, title, updatedAt, messageCount }[] }
DELETE /api/chat/:id         → 204
ChatMessageDTO = { id, role: 'user'|'assistant', content: string, toolCalls?: { name: string, args: unknown, result?: unknown }[], createdAt: number }
```

Message persistence is the DO's own SQLite (Agents SDK handles it); D1 is only read via tools.

**Briefs:** _P11 core seams_ (`packages/core`: C12 interfaces + `OllamaEmbedder` + `rrfMerge` + chat prompt/tool schemas) ∥ _P12 worker retrieval_ (`apps/web/src/worker` + `packages/db` migration: mode selector, all four adapters, wire ingest through the seams, C13 tool functions + `/api/search` upgrade to hybrid, re-embed backfill route). Then _P13 chat DO_ (C14) ∥ _P14 chat UI_.

### M4 — distribution

_P15:_ PWA manifest + service worker + installability audit. _P16:_ Tauri 2 wrap — configurable `VITE_API_BASE`, CORS middleware for the Tauri origin (ADR-0001), platform builds. Store distribution only if wanted.

### P6 — deploy (moved to LAST, 2026-08-03)

Per owner's decision to finish the full flow locally first, the deploy phase runs after M3 instead of after M1: create D1/Vectorize/`APP_TOKEN`, uncomment the AI + Vectorize bindings, swap local adapters for the CF impls, smoke-test, `wrangler deploy` (human-executed). Everything before it stays runnable offline.

---

## 6. Changelog & version registry

| Date       | Phase | Agent                                                                                       | Outcome / deviations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Versions locked                                                                                                                                                                                                                               |
| ---------- | ----- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-02 | —     | —                                                                                           | Plan created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                             |
| 2026-08-08 | P13   | opus subagent (abd228e6)                                                                    | **Done, DoD verified + LIVE CHAT CONFIRMED** (core 288→298, web 172→229). `streamChat` in `packages/core` (all `ai` imports stay there; `provider.ts` extracted so `create*` guardrail code isn't duplicated), `TilChatAgent extends AIChatAgent` DO with the three read-only tools, `POST /api/chat/ticket` + chat routes, D1 conversation index (`0004_chats.sql`). Live: asked "What have I saved about CSS?" → model called `search_entries` → grounded answer citing the real jvns.ca entry; history persisted; list/delete verified; owner data untouched. **Contract changes accepted:** (a) **C14 revised — there is no HTTP chat endpoint** in `@cloudflare/ai-chat@0.10.1`; chat is **WebSocket-only** via `cf_agent_use_chat_request` frames, routed under `prefix: "api"`. (b) `chatNoticeResponse` added so the no-settings path yields a readable assistant turn instead of an opaque stream error. (c) **`nodejs_compat` re-enabled** — `agents` statically imports `node:async_hooks`/`node:diagnostics_channel` and dev won't boot without it (`nodejs_als` insufficient); bundle 417→811 kB gzip. ADRs 0002/0003/0005/0008 corrected. (d) **WS ticket auth** (60 s HMAC ticket, WS-upgrade-only) after two header-based carriers failed on evidence — documented in ADR-0007; orchestrator security-reviewed: domain-separated HMAC, constant-time compare, expiry bounded both ends. (e) `DELETE` clears messages rather than destroying the DO (`destroy()` can't be awaited before answering 204). Honest gap: real DO lifecycle isn't unit-testable in plain vitest — covered by the live run, no fake test written. | @cloudflare/ai-chat 0.10.1 · agents 0.20.1 · @ai-sdk/react 3.0.248                                                                                                                                                                            |
| 2026-08-04 | P11   | opus subagent (aff6b948)                                                                    | **Done, DoD verified** (core 288, +58). C12 seams (`Embedder`, `VectorStore`, `StackMode`) + `createOllamaEmbedder` (`/api/embed`, batched, defensively L2-normalized, `EmbeddingError` on HTTP/count/dimension mismatch) + `retrieval.ts` (`rrfMerge` k=60, `cosineSimilarity`, `normalizeVector`, `embeddingTextFor`) + `chat.ts` (C13 `CHAT_SYSTEM_PROMPT` with untrusted-data + read-only clauses, tool schemas). Deviations accepted: chat surface in its own `chat.ts`; `embeddingTextFor` omits empty parts (worker's old version emitted blank lines); extra additive exports (`CHAT_TOOL_DESCRIPTIONS`, topK bounds, `RRF_K`); `embed([])` short-circuits; `rrfMerge` skips non-finite ranks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | no new deps                                                                                                                                                                                                                                   |
| 2026-08-04 | P12   | opus subagent (a81201c8)                                                                    | **Done, DoD verified + both modes exercised live** (web 78→172). ADR-0010 implemented: `resolveStack(env)` (unset/garbage → `local` with warning), `ReadabilityExtractor` replacing the regex stripper, `WorkersAIEmbedder`, `VectorizeStore` + `D1VectorStore` (migration `0003_vectors.sql`, cascade off `entries`), ingest wired through the seams, hybrid `searchEntries` with **FTS-only degradation when the embedder is unreachable**, `getEntryForTool`, 5 `stats` kinds, `POST /api/entries/reembed` backfill, `/api/health` now reports `{stack, embedder}`. Bundle 285→**417 kB gzip** (~14% of the 3 MiB ceiling) after importing `turndown/lib/turndown.browser.es.js` to drop 82 kB of unused domino. Deviations accepted: regex fallback deleted outright (a silent fallback would defeat the `ExtractionError` contract this phase exists to restore); `top_tags` expanded in TS via the single `parseTags` definition rather than `json_each` (the exact shape that silently returned 0 in M2). Live (Ollama absent): health reports `embedder:'unavailable'` without throwing, ingest still reaches `ready`, search degrades to FTS. Real embed path unverified — Ollama not installed.                                                                                                                                                                                                                                                                                                                                                                                                                                  | @mozilla/readability · linkedom · turndown                                                                                                                                                                                                    |
| 2026-08-04 | P12.1 | orchestrator patch                                                                          | **Done** (288 core tests still green). Fixed a live defect P12 hit: `MAX_MARKDOWN_CHARS` was 48k chars (~12k tokens), so a long article exceeded Groq's free 12k TPM and the entry **failed outright**. Lowered to 24k (~6k tokens, aligning with the synthesis cap) — a digest of the first ~4,000 words beats no digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P9a   | opus subagent (aa9b5b58)                                                                    | **Done, DoD verified** (core 230 tests, +78). C11 `synthesizeDigest` on both clients, all three dialects; new `SYNTHESIS_*` prompt/schema; `parseSynthesis` drops hallucinated `canonicalUrl`s, de-dupes, truncates to `maxItems`. Prompt cap 24k chars with an explicit "N omitted" note; dates rendered as UTC `YYYY-MM-DD` (no `Date.now()` in core). Deviation accepted: JSON schema omits `minItems`/`maxItems` (OpenAI strict mode rejects them) — bound enforced in `parseSynthesis`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P9b   | opus subagent (a4a052b7)                                                                    | **Done, DoD verified + LIVE RUN CONFIRMED** (web 74→78 tests). `DigestWorkflow` (WorkflowEntrypoint) with steps plan→fetch-per-source (Promise.allSettled, isolated)→rank→synthesize→persist, per-step retries; weekly cron `0 8 * * 1`; 4 routes per C10. **`vite dev` handled the Workflow binding with no API token — Workflows are fully local, unlike AI/Vectorize.** Live: one real run produced a `ready` digest, 5 ranked items, HN+Lobsters corroboration, one Groq synthesis call. Key decisions: `plan` step freezes `runAt` so retries can't drift the window; digest row id generated in `startDigestRun` before triggering (no 404 window for the UI poll); `persist` deletes existing items first (replay-safe); empty candidate pool → `failed` without an LLM call. Deviations accepted: `workflow_error` code added; `runDigest` returns `{status:'failed'}` rather than throwing. **Trap recorded:** drizzle renders raw `sql` columns unqualified in single-table selects — correlated subquery counts silently returned 0; fixed with leftJoin+groupBy (watch in P11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P10   | opus subagent (a3c293af)                                                                    | **Done, DoD verified** (isolated client typecheck clean; the 4 errors it saw were P9a's interface landing mid-flight, healed by P9b). Digest list + detail pages, `DigestCard`, `digest-format` helpers, nav entry, "Run now" → 202 → navigate. Polls at 2 s while `pending` (list polls only while a row is pending; detail per C7), stops on terminal state. Smoke-tested via headless Chrome incl. contract-shaped fixtures. Filed two integration gaps — one real, fixed below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P10.1 | orchestrator patch                                                                          | **Done** (web 78 tests). Fixed the gap P10 found: only the _list_ routes swept stale `pending` rows, so opening a zombie run/ingest directly polled forever. Extracted `sweepStalePending(deps, id?)` for digests and added the id-scoped sweep to **both** detail routes (`/api/digests/:id`, `/api/entries/:id`) + 4 tests (stale→failed, fresh→untouched, both routes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P7    | opus subagent (a6dabf48, resumed as aca2ab4f)                                               | **Done, DoD verified by orchestrator** (core 152 tests; strict greps clean: no `node:` imports, no `DOMParser`, no un-mocked fetch in tests). 4 adapters (`sources/hn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | lobsters                                                                                                                                                                                                                                      | arxiv | rss.ts`+`http/xml/registry`) + `ranking.ts`. First run died on a transient 529 after writing all implementation but **zero tests**; resumed with a test-only brief → 65 new tests, no impl bugs found. Real values (differ from brief assumptions — treat as the contract now): HN `minPoints`default 50, strict`points>50`; only HN/arXiv push `limit` to the wire (Lobsters/RSS filter client-side); Lobsters URL fallback is 3-step (`url`→`comments_url`→`/s/{short_id}`); scoring = `0.4·recency + 0.4·popularity(log1p, per-source max, 0.5 neutral when absent) + 0.2·corroboration(saturates at 3 sources)`, ties by `canonicalUrl`; title-merge Jaccard ≥0.8 **and** ≥3 tokens both sides; RSS errors two-tier (`rss:<host>`per feed via`onFeedError`, `rss` only when all fail). Default RSS feeds: Cloudflare blog, jvns.ca, simonwillison.net. | fast-xml-parser |
| 2026-08-03 | P8    | opus subagent (a8fb944b)                                                                    | **Done, DoD verified by orchestrator** (db 16 tests: FK-violation rejection under `PRAGMA foreign_keys=ON`, cascade delete, `(digestId, rank)` ordering, M1 FTS behavior untouched). C8 implemented; migration `0002_digests.sql` with FK cascade + both indexes. **Naming resolved:** row types export as `DigestRun`/`NewDigestRun` + `DigestItem`/`NewDigestItem` (tables `digests`/`digestItems`) to avoid collision with `@til/core`'s per-entry `Digest` — **P9 must use these names.** Also hit the same 529; work was complete before it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P5.3  | orchestrator patch                                                                          | **Done** (138 tests). Real ingest failed: most Groq models reject `response_format: json_schema` (`llama-3.3-70b-versatile` included). Fix: AI SDK client sets `providerOptions.groq.structuredOutputs = false` and uses the schema-in-prompt system message for Groq — the direct client's proven approach, extracted to a shared `jsonModeSystemPrompt()`. `parseDigest` remains the real validator, so provider-side enforcement is never load-bearing. Regression test asserts the wire body is never `json_schema` and that the system prompt carries the schema. Gateway-token leg confirmed working by this failure (request reached Groq).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P5.2  | opus subagent (ae09f8e3)                                                                    | **Done, DoD verified by orchestrator** (137 tests; owner's real settings row confirmed intact after the agent's live test — it backed up/restored local D1 unprompted). Settings UX fix driven by a real blocker (owner couldn't add a gateway token without re-typing the provider key). Implements amended C5/ADR-0007: `apiKey` omittable iff `provider`+`cfAccountId`+`cfGatewayId` unchanged (else 422 with explanatory message); `cfAigToken` absent→keep, `""`→clear. UI: key field labelled optional with masked placeholder, amber warning when routing edits make it required again, gateway-token field relabelled `cf-aig-authorization` with clear-token checkbox. Key still never leaves the server (no client-side storage, no pre-fill).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P5.1  | opus subagent (ade8b1c0)                                                                    | **Done, DoD verified by orchestrator** (129 tests total; greps clean). Groq added as third BYOK provider after owner's key turned out to be Groq (free tier) — contract change C4/C5 + TDR/ADR-0002 updated first. Direct client: OpenAI-compatible wire + `json_object` + schema-in-prompt (JSON-mode hint composed per-provider without touching the shared prompt); AISDK client: `createGroq` with gateway baseURL (asserted final URL `…/groq/chat/completions`). Settings UI: Groq option + model placeholder. Owner model guidance: `llama-3.3-70b-versatile` (default), `openai/gpt-oss-*` for strict json_schema. Clarified: CF AI Gateway pass-through is free — the "payment" screen was the optional Unified Billing/stored-keys feature (+5% fee), which we don't use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | @ai-sdk/groq 3.0.55 (exact)                                                                                                                                                                                                                   |
| 2026-08-03 | P5    | orchestrator-led (no subagent — evidence largely existed from P3 transcript + smoke checks) | **Machine-verifiable §13 items PASS**: dev stack boots; migrations applied `--local`; live pass: 201→pending→failed-with-real-fetch-reason, 409 duplicate, 400 unsafe (169.254.169.254), 400 invalid, 422 partial settings, 401 no-token, search shape, suites 115/115. **Human leg CONFIRMED 2026-08-03** (owner + orchestrator evidence): Test connection OK through an **Authenticated Gateway** (token required — see P5.2), and the golden path produced a genuine `ready` entry (real title/summary/takeaway/3 tags) via **Groq** `llama-3.3-70b-versatile`; live FTS5 search matched it on words from the takeaway ("documentation", "permission"), proving triggers + search route on real data. Failure paths also exercised organically (404 fetch, unsupported response_format) with readable errors. Provider actually in use: **Groq** (not OpenAI as first planned — free tier). **M1 COMPLETE.** Deferred to P6: delete→Vectorize-vector removal and Workers-AI `toMarkdown` quality (local runs use `DevFallbackExtractor`; bindings off).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P3    | opus subagent (a8e2112b)                                                                    | **Done, DoD verified by orchestrator** (35 worker tests; live curl: health 200 no-auth, 401 without token, 201→pending→failed-with-reason pipeline, 400 unsafe, 409 duplicate + `existingId`, 422 partial settings, masked GET). DI via `createApp(depsFor)`. Deviations accepted: `tsconfig.test.json` split (test harness uses node builtins); typecheck script now REAL (`tsc --build`) — old one was a silent no-op; `drizzle-orm` direct dep on web (pnpm no-hoist); manual XOR length-safe token compare (Workers lack `timingSafeEqual`); `DevFallbackExtractor` when `env.AI` absent (bindings stay commented till P5/P6). Workers-AI shapes recorded: `AI.toMarkdown({name, blob})` → `.data`; `AI.run('@cf/baai/bge-m3',{text})` → `data[0]`. P5 note: run `wrangler d1 migrations apply til --local` on fresh checkouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | zod 4.4.3 · @hono/zod-validator 0.7.5                                                                                                                                                                                                         |
| 2026-08-03 | P4    | opus subagent (a186b672)                                                                    | **Done after one orchestrator patch.** SPA per C5/C7: token gate (localStorage + 401→gate + cache clear), feed (optimistic pending, 409→navigate, debounced search, infinite scroll), detail (2 s poll while pending, reingest/delete), settings (full-replace form, masked placeholder, test-connection). Patch: `FeedPage` `useInfiniteQuery` 3rd generic fixed to `InfiniteData<EntryListPage>` — P4's "clean typecheck" had run against the old no-op script; caught by P3's real one. Contract notes filed: EntryDTO digest fields are `string\|null` until `ready` (C5 clarified de facto); `existingId` lives at envelope top level. Sign-out button added (accepted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | no new deps (C7 stack from P0)                                                                                                                                                                                                                |
| 2026-08-03 | P1    | opus subagent (a50a37c1)                                                                    | **Done, DoD verified by orchestrator** (fresh `--force` runs; 6/6 tests). Migrations: `0000_init.sql`, `0001_fts.sql` (+ drizzle `meta/` — wrangler ignores non-`.sql`). Deviations accepted: `@types/node` devDep (tests only; `src/` stays edge-safe), tsconfig widened to include `test/`. P3 notes: `createDb`/`Db` exported; never split migration SQL on `;` (trigger bodies) — use whole-file exec or `--> statement-breakpoint`; `tags` is a JSON string; ids are caller-supplied `crypto.randomUUID()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | drizzle-orm 0.45.2 · drizzle-kit 0.31.10 · better-sqlite3 13.0.2                                                                                                                                                                              |
| 2026-08-03 | P2    | opus subagent (a45c0ef4)                                                                    | **Done, DoD verified by orchestrator** (74/74 tests; greps clean: no `ai` imports outside core, no `node:` in core, no plain model strings). Structured output via v6 **Output API** (`generateText` + `Output.object`), zod schemas. Deviations accepted: extra tracker params stripped; `assertSafeUrl` also blocks `0.0.0.0/8` + IPv6 ULA; `canonicalUrl` strips trailing slash (dedupe semantics). P3 notes: Anthropic `baseURL` needs `/anthropic/v1` (SDK appends `/messages`); pass Worker `fetch` via `fetchImpl`; `ping()` never throws; `Digest` strings pre-trimmed/lowercased.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ai 6.0.240 (exact) · @ai-sdk/openai 3.0.90 · @ai-sdk/anthropic 3.0.104 · zod 4.4.3                                                                                                                                                            |
| 2026-08-02 | P0    | opus subagent (a6b2b2b7)                                                                    | **Done, DoD verified by orchestrator** (fresh `--force` runs + dev-server curl: `/api/health` 200, SPA served). Deviations accepted: `ai`+`vectorize` bindings commented until P3 (see C2 amendment); workers-types over `wrangler types` codegen; separate bare `vitest.config.ts` (CF plugin rejects vitest's `resolve.external` — use `@cloudflare/vitest-pool-workers` when binding-level tests are needed); lib stubs build with `tsc --noEmit` (benign turbo output warnings); `.npmrc` allows esbuild/workerd postinstall (pnpm 10 blocks by default); prettier normalized `docs/**` formatting. Note: `react-router` v8 has no `-dom` package; Tailwind v4 configures via CSS, no config file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pnpm 10.5.2 · turbo 2.10.8 · ts 5.9.3 · vite 8.2.0 · @cloudflare/vite-plugin 1.50.0 · wrangler 4.118.0 · hono 4.12.33 · react 19.2.8 · react-router 8.3.0 · @tanstack/react-query 5.101.4 · tailwindcss 4.3.3 · vitest 4.1.10 · eslint 9.39.5 |

---

## 7. Change control

- Contract change = edit §2 here + sync [tech-design.md](./tech-design.md)/ADRs in the same commit, then re-brief affected phases.
- New risks discovered during implementation go to TDR §14, not this file.
- This plan is the orchestrator's runbook: future sessions should read **this file + the referenced contract sections only** to dispatch the next phase — reading the whole docs set is not required.
