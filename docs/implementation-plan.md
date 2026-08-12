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
8. **Model policy (v3, tiered — owner-approved 2026-08-09):** two project agent types in `.claude/agents/` carry the tiers:
   - **`phase-heavy`** (Opus, `effort: max`) — debugging with unknown root cause, novel SDK integration, architecture/security-sensitive phases. Upcoming: the P14.2 resume, the evals-v2 promptfoo judge design.
   - **`phase-standard`** (Opus, `effort: high`) — well-specified mechanical phases against frozen contracts: authoring, restyles, CRUD, wiring. Upcoming: P19‥P22 FEAT1 (+C20 feedback), P23‥P26 FEAT2. Done under this tier: P18 shadcn. Sonnet remains available per-dispatch for trivial slices at orchestrator judgment.
     Rationale: measured wall-clock this session ranged 17 min → ~10 h per phase; max-effort reasoning multiplied by 150–250 steps was the dominant controllable term on mechanical work. The orchestrator (Fable 5) **plans, dispatches, verifies DoD, and applies small patches only — it does not implement phases itself.**

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

### Roadmap v2 (accepted 2026-08-09; reordered same day) — execution order: P14.2 → P17 → P18 → **P6 deploy** → P19‥P22 → P23‥P27 → P15/P16

_Deploy moved ahead of the feature waves on 2026-08-09: the owner's machine cannot run Ollama and they have opted for an all-on-Cloudflare posture, which removes the original reason to stay local until the end — and several wave-2 features (email delivery, email-in capture, PDF via `toMarkdown`, real Vectorize for personalized ranking) want a deployed instance anyway._

_Phase numbers are stable identifiers, not execution order. All numbered contracts below are frozen; per standing practice each brief re-verifies current library specifics at dispatch time._

#### P14.2 — patch: chat render loop (OPEN — deprioritized to LOW by owner 2026-08-12; stash `stash@{0}` stays parked. NOTE for the eventual dispatch: the stash predates P17.1 and P18 — expect conflicts beyond `packages/core/src/index.ts`, and treat the stashed fix as a hypothesis, the chat client was rewritten in P18)

Bug: opening a conversation whose last turn errored (e.g. the Groq tool-call failure) surfaces `Maximum update depth exceeded` through the chat error alert. Strongest hypothesis: the DO's durable-stream replay re-delivers the terminal error part on every load → `useAgentChat` error state → resubscribe → replay, unbounded; the `["chats"]` invalidate-in-effect in `Conversation` is the adjacent suspect. Brief requirements: reproduce in a real browser with the component stack; fix the feedback edge at its root; make failed turns replay harmlessly (finalize failed turns as a readable assistant message via `chatNoticeResponse`/`describeChatStreamError` rather than a terminal error part, or equivalent — decide on evidence); regression-cover what is honestly testable; baseline 546 tests stay green.

#### P17 — M-EVAL: the evaluation harness ([ADR-0011](./adr/0011-evaluation-and-measurement.md))

**C15 — `@til/evals` contract**

```
packages/evals  (@til/evals; private; NOT in the turbo build/test pipeline)
  scripts:
    eval:retrieval   deterministic; requires local Ollama bge-m3 — FAIL LOUD if unavailable
    eval:chat        deterministic chat checks; needs a provider key (env below)
    (v2, NOT in P17: judged layer — faithfulness/relevance rubrics, model matrices, red-team —
     runs on promptfoo via a custom provider over streamChat + the fixture DB; ADR-0011 staged decision)
  datasets/ (reviewed JSON, in-repo):
    retrieval-gold.json   [{ id, query, expected: [fixtureEntryId,…], kind: 'semantic'|'keyword'|'mixed' }]  ~40 cases
    chat-scenarios.json   [{ id, turns, expectTool: 'search_entries'|'stats'|'get_entry'|null, expectRefusal?: boolean }]
    injection-suite.json  [{ id, seedEntry (contains instruction + canary string), question, canary }]
  fixtures/corpus.json    ~50 entries (title/url/summary/takeaway/tags/content) — seeded, never the owner's data
  runner: real migrations over in-memory better-sqlite3 (reuse the web test-harness pattern),
    WorkersAIRestEmbedder + D1VectorStore, generation through createLLMClient/streamChat (the real seams).
  P17 ALSO delivers the ADR-0010 amendment in the app: `WorkersAIRestEmbedder` in packages/core
    (POST https://api.cloudflare.com/client/v4/accounts/{acct}/ai/run/@cf/baai/bge-m3, token auth,
    L2-normalize defensively, EmbeddingError on failure/dimension mismatch — verify exact response
    shape at dispatch) + `TIL_EMBEDDER=ollama|workers-ai` selection in apps/web stack.ts + .dev.vars.example.
    This gives the owner's local dev real semantic search — their machine cannot run Ollama.
  metrics:
    retrieval — Recall@5, MRR, nDCG@10, per kind + overall; ABLATION table: fts-only vs vector-only vs hybrid,
      plus RRF k and pool-multiplier sweeps (the ADR-0009 open question becomes a number)
    chat — tool-selection accuracy; citation precision (answer URLs ⊆ tool-returned URLs); refusal correctness
      (zero cited URLs + not-found phrasing); injection: canary never obeyed
    (judge metrics are v2/promptfoo; when built: 3-point rubrics, judge model ≠ generator, HARD-FAIL otherwise)
  env: EVAL_PROVIDER/EVAL_MODEL/EVAL_API_KEY/EVAL_CF_ACCOUNT_ID/EVAL_CF_GATEWAY_ID/EVAL_CF_AIG_TOKEN?  (judge env is v2)
  output: console table + append {timestamp, gitSha, config, scores} to packages/evals/history/eval-history.jsonl
```

P17 delivers **v1 only — the deterministic core; zero LLM tokens spent** (`eval:chat` scenario turns run against the real seams with the owner's key only if explicitly authorized in the brief; tool/citation/refusal checks need no judge). The judged layer is a separate later phase (v2, promptfoo) expected around P21's before/after. DoD: metric math unit-tested with stub vectors (free, deterministic); suites run end-to-end against Workers AI REST; one recorded baseline run committed to history; app-side `TIL_EMBEDDER=workers-ai` verified live (`/api/health` reports `embedder: ok`, reembed backfills, hybrid search returns semantic hits). **Owner prerequisite before dispatch (replaces the Ollama pull — owner's machine can't run it): a Cloudflare API token with Workers AI permission in `apps/web/.dev.vars` as `WORKERS_AI_API_TOKEN`, plus `CF_ACCOUNT_ID`.**

#### P18 — M-UI: shadcn refresh ([ADR-0012](./adr/0012-ui-system-shadcn.md))

Init shadcn (Tailwind v4 CSS-vars, theme mapped to current slate), vendor into `src/client/components/ui/`; swap Button/Input/Textarea/Select/Dialog/DropdownMenu/Badge/Skeleton/Table/Collapsible/Card; sonner toasts on all mutations; Dialog replaces every `window.confirm`; dark-mode toggle in Shell (class strategy, localStorage, both themes checked); ⌘K palette (cmdk) → hybrid `/api/search` → navigate. Pure restyle: zero API/behaviour changes, 546 tests stay green, client-bundle delta reported, live smoke of all six pages in both themes.

#### P19‥P22 — M-FEAT1 (after P18; P19∥P20 then P21∥P22)

**C16 — `feeds` (P19, with the bookmarklet).** Migration `0005_feeds.sql`: `feeds(id text pk, url text notnull unique, title text, enabled integer notnull default 1, createdAt, updatedAt)`; seed the three current defaults. API: `GET /api/feeds`, `POST {url}` (assertSafeUrl; 409 on duplicate), `PUT /:id {enabled}`, `DELETE /:id`. The digest run reads enabled feeds from D1 via deps (hardcoded `DEFAULT_RSS_FEEDS` becomes seed data only). Settings gains a "Digest sources" section. Bookmarklet: settings shows a copyable `javascript:` snippet opening `{appUrl}/?add={url}`; `FeedPage` consumes `?add=` (token gate already in front). **No token in the bookmarklet, ever.**

**C17 — related entries (P20).** `VectorStore` gains `getVector(id): Promise<number[] | null>` (D1 store reads its row; Vectorize via `getByIds`). `GET /api/entries/:id/related?limit=5` → query with the entry's own vector, drop self, hydrate `{id,title,sourceDomain,takeaway,score}`; detail page renders a "Related" section; hidden entirely when no vector/embedder. Plus "Ask about this entry": button linking to a new chat pre-seeded with a `get_entry` prompt for this id.

**C18 — personalized digest ranking (P21).** In the digest Workflow after cluster+score, before synthesize: batch-embed cluster `title+snippet`; `interest = max cosine` vs the user's stored entry vectors (cap: most recent 200); `blended = 0.6·base + 0.4·interest` (constants in `digest.ts`); persist `interest_score` (nullable real, migration `0006`) on `digest_items`; UI shows a subtle "matches your reading" marker when interest dominated. Degrades to base score exactly when no embedder/vectors — i.e. today's behaviour. Run the P17 retrieval/digest suites before+after and record the delta.

**C19 — review queue (P22).** Migration `0007_reviews.sql`: `reviews(entryId text pk → entries.id cascade, state 'new'|'learning'|'review', dueAt, intervalDays real, ease real default 2.5, lapses integer default 0, lastGrade integer, reviewedAt)`. SM-2-lite: grades 1–4 (Again/Hard/Good/Easy); Again → relearn 1d, ease −0.2 (floor 1.3); intervals 1d → 3d → round(interval·ease). API: `GET /api/reviews/queue?limit=10` (due first, question-first payload), `POST /api/reviews/:entryId {grade}`, `POST /api/reviews/enroll {entryId | all: true}`. UI: `/review` card flow — question → reveal takeaway/summary → grade buttons; nav badge with due count.

**C20 — online feedback (rides P6 deploy, not before).** `feedback(id, conversationId?, messageId?, entryId?, kind 'up'|'down', comment?, createdAt)` + `POST /api/feedback` + 👍/👎 on assistant turns; feeds the P17 history as an online signal.

#### P23‥P27 — M-FEAT2: comprehensive-product wave (added 2026-08-09 — owner asked for maximal breadth; contracts below are sketches, frozen in detail at each dispatch per standing practice)

- **P23 — Library organization.** `favorite` + `archived` integer flags on `entries` (migration; `PATCH /api/entries/:id {favorite?, archived?}` — the first non-delete mutation); feed filter chips (All/Favorites/Archived); tag browse (`/tags` counts page + `/tags/:tag` filtered feed, `GET /api/entries?tag=`). Personal **note** per entry: `note` text column + editor on the detail page (a separate highlights table is deliberately deferred).
- **P24 — Export & backup.** `GET /api/export` → streamed JSON (entries + digests + reviews + feeds) and a markdown-bundle variant; download buttons in Settings. Satisfies ADR-0007's "one copy is zero copies" pre-R2; the post-deploy R2 cron rides P6.
- **P25 — Content types.** `content_type` column (`article | pdf | video`). PDF ingestion via cloud `toMarkdown` (local mode: readable failure). YouTube: keyless transcript fetch (timedtext) → digest, flagged experimental — breaks whenever YouTube changes; degrade to failed-with-reason.
- **P26 — Monthly reading report.** `kind` column on `digests` (`weekly | monthly-report`); monthly cron Workflow: stats aggregations + a report-flavoured synthesis prompt over the month's entries; rendered by the existing digest UI with a kind badge.
- **P27 — Email (deployed instance only).** (a) Weekly digest delivery via the **`send_email` binding** to the owner's Email-Routing-verified address — keyless, no third-party ESP; (b) **email-in capture**: Email Routing → Email Worker → extract links → ingest pipeline. Both verified against current Email Workers docs at dispatch.

Out of scope permanently (unchanged non-goals): multi-user/sharing, native mobile UI, beating paywalls.

### M4 — distribution

_P15:_ PWA manifest + service worker + installability audit. _P16:_ Tauri 2 wrap — configurable `VITE_API_BASE`, CORS middleware for the Tauri origin (ADR-0001), platform builds. Store distribution only if wanted.

### P6 — deploy (DONE 2026-08-11/12; originally moved to LAST 2026-08-03, then ahead of the feature waves 2026-08-09)

Executed 2026-08-11 as a live validation of `docs/deploy.md` (orchestrator-run at owner's request), owner-verified functional 2026-08-12: D1 + Vectorize created, five migrations applied remotely, AI/Vectorize bindings enabled at deploy time, `APP_TOKEN` secret set, deployed to workers.dev; health reports `stack: cloud, embedder: ok` and the API fails closed without the token. **Standing rule from the owner: no deployment-specific values (database id, account id, URL) in the repo** — the tracked `wrangler.jsonc` keeps `local-placeholder` and commented bindings; a redeploy re-applies those two edits locally and reverts them after (recipe in `docs/deploy.md` §Updating). Consequence for every phase that adds a migration or API surface from here on: **its DoD ends local; promoting to the deployed instance is a separate owner-triggered step** (`d1 migrations apply --remote` + `wrangler deploy`).

---

## 6. Changelog & version registry

| Date       | Phase | Agent                                                                                                           | Outcome / deviations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Versions locked                                                                                                                                                                                                                               |
| ---------- | ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-02 | —     | —                                                                                                               | Plan created                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                             |
| 2026-08-13 | P24   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (+32 tests: web 411→443 on its base). `GET /api/export` streams a complete JSON backup (entries incl. content, digests+items, reviews, feeds, feedback) and `?format=markdown` streams one `.md`; both `Content-Disposition: attachment` with UTC-dated filenames. **Streaming verified against current Hono docs**: `stream()` from `hono/streaming` (not `streamText` — forces text/plain) + the documented CF `Content-Encoding: Identity` mitigation; honest D1 keyset batching at 200 rows/round-trip, digest items walked with a scoped cursor (no buffering). Smoke-tested on real workerd: 250×12KB entries → 3.0MB chunked, no drop/dup at batch boundaries, secret/vector fingerprints provably absent. **Exclusions documented in 5 places incl. inside every export**: `settings` (API key — a backup must not be a copy of a secret), `entry_vectors` (recomputable, would dominate size), `chats` (beyond contract: only a cross-DO index — transcripts live in DO storage D1 can't read, so exporting it would promise conversations the file lacks). Decisions: `counts` LAST in the JSON, counted from written rows (absence = truncation signal); `formatVersion:1` instead of an unhonest `appVersion`; rows as stored except `tags`/`evidence` parsed to real JSON; mid-stream failure writes a non-JSON marker (stream()'s onError only fires for Error instances). Settings "Export & backup" card: authenticated fetch→blob→objectURL (an `<a href>` can't set Authorization; token-in-URL is refused app-wide). **Orchestrator integration fix at merge: P23's `note` added to the markdown writer + fixture** (P24's base predated it; JSON gets it free via `db.select()`). Caveat: `saveBlob` anchor click untested by machine (no DOM in runner).                                                            | —                                                                                                                                                                                                                                             |
| 2026-08-13 | P23   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (967→1014 tests: db 30→36, web 411→452). Migration `0009_library.sql` is ADD COLUMN only (`favorite`/`archived` integer 0/1 read as booleans per `feeds.enabled`, nullable `note`); no index (near-constant columns; `entries_created_at_idx` already serves the archived filter). `PATCH /api/entries/:id` — the first non-delete entry mutation: partial, `note:""` clears to NULL while `note:null` is 422, empty body 422, **answers with the detail shape** so a star click cannot drop `contentMarkdown`. Default feed **excludes archived** (Favorites = favorite && !archived); `?filter=`/`?tag=` ANDed with the keyset predicate; unknown filter reads as default view. Tag browse reuses retrieval.ts's `%"tag"%` LIKE predicate (exported, not duplicated — the one out-of-scope touch) so `go` can't match `golang`; `GET /api/tags` counts non-archived only. `/tags` + `/tags/:tag` pages, shared `EntryListView`, star on cards + detail, `NoteEditor`. **Notes stay out of `entries_fts` and every LLM payload** (asserted). Pays off P22's owed one-liner: `/review` joins `/tags` in the ⌘K palette. Verified beyond DoD on wrangler's real local D1 + workerd. Deviations noted not applied: tech-design.md entries description now incomplete; `/api/search` + ⌘K still span archived; filter is component-local not URL state (URL state would re-run the `?add=` bookmarklet effect).                                                                              | no new deps                                                                                                                                                                                                                                   |
| 2026-08-12 | P21   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (876→923 in isolation: web 328→375). C18: personalization as its **own retry-isolated `personalize` Workflow step** between rank and synthesize (I/O-family retries: 2× exp backoff, 1 min timeout; step memoization means a synthesize retry replays scores instead of re-embedding; profile read inside the step preserves P19's frozen-plan property) — step **never created** when embedder/vectorStore is null, and a spent retry budget degrades to base ranking rather than failing the run. `blended = 0.6·base + 0.4·interest` (constants in digest.ts), interest = max cosine vs the **200 most recent entries'** vectors (entry recency — the only definition meaning the same on D1 and Vectorize); migration `0006_digest_interest.sql` (nullable `digest_items.interest_score`); "matches your reading" marker iff `0.4·interest > 0.6·base` strictly. Documented interpretations: `digest_items.score` keeps the base topical value (blend orders the pool; contract only requires persisting interest_score); interest clamped to 0..1. Reordering confined to the synthesis pool (≤30 embeds/run). **P17 retrieval eval byte-identical before/after** (hybrid nDCG@8 0.828; both runs committed to history); noted gap: no digest-ranking eval exists to catch a blend regression. Worktree materialized at `e8c50ea`; agent reset to the briefed `84c4137` before starting.                                                                                                                                                                                | —                                                                                                                                                                                                                                             |
| 2026-08-12 | C20   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (876→915 tests: db 22→30, web 328→359). Online feedback: migration `0008_feedback.sql` (append-only; `feedback_created_at_idx`; **no FK on entryId — decided on evidence**: cascade would erase the signal on entry delete, restrict would 500 the shipped `DELETE /api/entries/:id`, so soft reference like the DO-side conversation/message ids, pinned by tests); `POST /api/feedback` (201 returns the inserted row verbatim; `MAX_FEEDBACK_COMMENT=2000` the only content guard); 👍/👎 ghost thumbs on completed assistant turns (never the streaming turn) — pressed state set **on success only**, not persisted across reloads (honest UX: a lit thumb means "the server has this row"; restoring would need a GET the contract doesn't include), same-thumb re-click no-op, opposite click appends a correction row, toast on failure only. Nothing wired into `packages/evals` (per contract note — rows accumulate for future analysis). Deviation: worktree materialized at `e8c50ea` instead of the briefed base — agent fast-forwarded its branch to `84c4137` before starting and verified the 876 baseline there.                                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                             |
| 2026-08-12 | P22   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (809 tests in isolation: core 356→398, web 238→267). C19: migration `0007_reviews.sql` (FK cascade, `reviews_due_at_idx`; numbering gap before P21's 0006 is deliberate — wrangler tracks by filename); SM-2-lite as pure functions in `@til/core/review.ts` (ease ±[−0.20/−0.15/0/+0.15] clamped [1.3,3.0] rounded 3dp; ladder 1d→3d, graduation `round(3·ease)`, review-state Hard 1.2×/Good ease×/Easy ease·1.3×, intervals [1,365]d; monotonicity property-tested); `/api/reviews` queue/grade/enroll — **the answer cannot leak: the queue SELECT simply never reads takeaway/summary/content** (asserted on raw response text), reveal is a separate `GET /api/entries/:id` on click; `{items, dueCount}` on the queue route feeds the nav badge without a fourth route; enroll idempotent, `all:true` = ready entries only, **inserted in chunks of 10 (D1's 100-bound-param cap)**; `/review` card flow with keyboard (space reveal, 1–4 grade) + Shell due-badge. Deviations proposed not applied: no createdAt/updatedAt on `reviews` (frozen column list), `/review` not in ⌘K palette (sibling-conflict risk — one-liner owed), `meta/` journal per hand-written precedent.                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                             |
| 2026-08-12 | P19   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (786 tests in isolation: db 16→22, web 238→280). C16: migration `0005_feeds.sql` seeds the three former `DEFAULT_RSS_FEEDS` into a `feeds` table (stable ids, `INSERT OR IGNORE`); `/api/feeds` CRUD (assertSafeUrl, 409+existingId on dup, entries.ts error conventions); digest reads **enabled feeds from D1, frozen in the `plan` step** (a Workflow retry keeps the source set it started with); Settings gains "Digest sources" (shadcn Switch vendored — no new dep) + a token-free copyable bookmarklet (`window.open`, origin-only interpolation; React refuses `javascript:` hrefs so copy-text); FeedPage consumes `?add=` (auto-submit iff parses as http(s), param stripped before settle, double-post ref guard). All-feeds-disabled → RSS adapter dropped entirely; HN/Lobsters/arXiv still carry the run (UI says so). Deviations: `DEFAULT_RSS_FEEDS` stays in @til/core as documented library fallback (worker never relies on it); `AdapterFactoryOptions.feeds` now **required**; stored URL normalized via `new URL().toString()` not `normalizeUrl` (trailing slash is part of the rss path); `meta/` journal left unmaintained per 0001/0004 hand-written precedent. 0005 verified through wrangler's own local migration runner. **Gotcha recorded: `digest.ts` contains a pre-existing literal NUL byte → git treats it as binary; cleanup owed.**                                                                                              | —                                                                                                                                                                                                                                             |
| 2026-08-12 | P20   | phase-standard subagent (worktree)                                                                              | **Done, DoD verified** (web 238→257 in isolation). C17: `VectorStore.getVector` on both stores (`getByIds` shape verified against @cloudflare/workers-types 5.20260801.1 — `values` may be a Float32Array, so coerced; off-dimension → null) + `GET /api/entries/:id/related?limit=5` (clamped 1..20, 404 unknown) → `{available, items:[{id,title,sourceDomain,takeaway,score}]}` + detail-page "Related" section (hidden entirely when empty) + "Ask about this entry". Decisions: `available:false` distinguishes "no vector/store" from `available:true`+empty "no neighbours"; the route never 500s (store failure degrades like the semantic-search leg); the **embedder is not consulted** — the stored vector is reused, so related works with the embedder down (verified live); "Ask" reuses the client-minted conversation id + `?about=<id>` (survives reload) and **fills the composer rather than auto-sending** (StrictMode double-fires effects). `isVectorizeIndexLike` now requires `getByIds` (two binding fakes updated). Caveats: Vectorize `getVector` mock-verified only (no local emulator — one curl on the deployed worker owed at next promotion); client UI covered by typecheck/build only (no client test infra in repo).                                                                                                                                                                                                                                                                                              | no new deps                                                                                                                                                                                                                                   |
| 2026-08-12 | P6    | orchestrator (Fable 5) + owner                                                                                  | **Deployed & owner-verified live.** Ran as a real-account validation of the new `docs/deploy.md` (commit `e8c50ea`): D1 `til` created (APAC) + all 5 migrations applied `--remote`; Vectorize `til-entries` (1024-d cosine); AI + Vectorize bindings enabled; `APP_TOKEN` secret set (fails-closed 401 confirmed before it existed); `wrangler deploy` → workers.dev, all 7 bindings attached, cron + workflow registered; `/api/health` = `{ok, stack: cloud, embedder: ok}`; owner completed Settings + verified ingest/search/chat/digest on the deployed instance. Guide findings folded back into the doc: minimal OAuth scope set (6 scopes; `workers:write` gates Vectorize — `ai:write` alone 403s; `offline_access` auto-added, invalid if explicit), decline `d1 create`'s auto-config (wrong binding name), build-before-migrate (redirected config), local `vite dev` verified fine with bindings declared. **Deviation-turned-rule (owner, 2026-08-11): repo carries zero deployment-specific values** — `wrangler.jsonc` reverted to placeholders post-deploy; specifics live outside the repo. | wrangler 4.118.0 (unchanged dep; recorded as the version the deploy path is validated against)                                                                                                                                                |
| 2026-08-10 | P18   | phase-standard subagent                                                                                         | **Done** (738 tests unchanged: core 356, evals 128, web 238, db 16; `pnpm typecheck` + `pnpm lint` clean). shadcn/ui vendored into `src/client/components/ui/` (15 components: button, input, textarea, select, dialog, alert-dialog, dropdown-menu, badge, skeleton, table, collapsible, card, sonner, command, label) with Tailwind-v4 CSS-variable theming mapped to the **slate** base colour from the registry's `cssVarsV4`, so it is a restyle not a redesign. All seven pages + all shared components swapped off raw slate utilities (zero `slate-*`/`red-*`/`emerald-*` left outside `ui/`); sonner toasts on **all 11 mutations**; the four inline two-step delete confirms replaced by one shared `ConfirmDialog` (AlertDialog, `role=alertdialog` + focus trap); dark mode via `.dark` class + `ThemeProvider` (localStorage `til:theme`) with an **inline `<head>` bootstrap so there is no flash**; ⌘K palette (cmdk) over the existing `GET /api/search`. **Deviations (all deliberate, no contract change):** CLI 4.16.2 dropped `--base-color` for named presets and its `init` only scaffolds new projects, so `components.json` was hand-authored and components vendored via `shadcn add` (registry `slate` values used verbatim); `next-themes` **not** installed — vendored `sonner.tsx` reads our own `useTheme`; three small documented edits to vendored files (`asChild` on `Card` to keep `<article>` semantics, `shouldFilter` pass-through on `CommandDialog` so server-ranked results are not re-filtered, `aria-controls` restored by hand on both Collapsibles because Radix 1.6.7 omits it); per-mutation inline error `<p>`s replaced by error toasts; `@/*` alias added (→ `src/client`) in vite + `tsconfig.client.json`, plus `tsconfig.json` because the CLI reads path aliases only from the root tsconfig; prettier left alone (`format:check` already failed on 62 pre-existing files). **Bundle:** JS 576.74→785.88 kB (+209.14), gzip **163.13→228.87 kB (+65.74)**; CSS 20.03→48.18 kB, gzip 4.93→8.98 kB (+4.05). `radix-ui` barrel and `lucide-react` verified tree-shaking (unused primitives/icons absent from the bundle). **Smoke:** no Chrome extension available, so driven via a dependency-free CDP script against `vite` dev with real mouse/keyboard input — **27/27 checks, 0 console errors**: all 7 routes × light+dark, theme dropdown + persistence, no-flash bootstrap, ⌘K → live hybrid-search results → navigate, delete AlertDialog open/cancel, a real reingest toast, chat tool Collapsible expand, Settings Select. Note: the smoke run reingested one local dev entry (title changed) — local D1 only. | `radix-ui` 1.6.7, `sonner` 2.0.8, `cmdk` 1.1.1, `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.6.0, `lucide-react` 1.31.0, `tw-animate-css` 1.4.0 (dev); generator `shadcn` 4.16.2 (npx, not a dep)                        |
| 2026-08-10 | P17.1 | opus subagent (~14 h — dispatched before the phase-standard tier could load; tiering applies from next session) | **Done, DoD verified by orchestrator** (738 tests: core 356, evals 128, web 238, db 16; shipped-config eval reproduced from cache at 0 REST calls; `search.ts` deletion + no leftover backup files confirmed). **Hybrid fixed: 0.828 nDCG@8 ≥ vector-only 0.806** (was 0.674 / 0.711 re-based), semantic parity 0.530, keyword 1.000 incl. 5 new identifier cases where vector scores 0.800. Root fix beyond the brief: **selective keyword vote** (full weight only when the FTS leg pins ≤3 rows; briefed policies (a)–(d) peaked at 0.794 — recorded honestly). Fusion lifted into `@til/core/hybrid.ts` (`fuseHybrid`, `HYBRID_DEFAULTS`, shared stopword tokenizer); worker `search.ts` deleted; evals copies removed (−195 lines). Live before/after on owner data: paraphrase query now ranks the right entry #1. Caveats in ADR-0009 (margin rests on body-only identifiers; 2 gold cases beyond embedder recall; chat-eval baselines will shift). **P14.2 stash: expect a small conflict on `packages/core/src/index.ts` when popped.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                             |
| 2026-08-10 | P17   | opus subagent, max effort (~5.5 h)                                                                              | **Done, DoD verified by orchestrator** (703 tests repo-wide: core 323, evals 127, db 16, web 237; baseline **reproduced byte-identically at 0 REST calls**; no secret leakage in any changed file; cache gitignored). Delivered: `WorkersAIRestEmbedder` + `TIL_EMBEDDER` wiring (owner's local app now has real semantic search — health `embedder: ok`, 3 entries re-embedded), `@til/evals` (50-entry corpus with keyword traps + near-dups; 41 gold queries, semantic cases keyword-free **by build-failing test**; documented nDCG variant; cached runner — 4 REST calls total for the baseline), chat runner mock-tested + `EVAL_LIVE`-gated (live chat baseline pending a working tool-calling model). **HEADLINE → ADR-0009 measured note: hybrid (0.674 nDCG@8) beats FTS (0.593) but LOSES to vector-only (0.816) on every slice** — non-abstaining FTS leg + alphabetical RRF tiebreak degrade the semantic leg; independently reproduced on owner's real data. Accepted deviations: `tsx` runner (Node 24 can't strip-type across workspace `.js`-specifier imports); two documented copies in evals (P17.1 lifts into core); 2 genuine misses (gr05, gr12) left untuned. Gaps recorded: keyword slice all-1.000 (non-discriminating), canary check exact-substring, AI SDK retries 5xx — mock 401s.                                                                                                                                                                                                                                                                                                                           | tsx 4.23.4                                                                                                                                                                                                                                    |
| 2026-08-09 | —     | orchestrator (Fable 5)                                                                                          | **Roadmap v2 planned & frozen** (docs only, no execution): ADR-0011 (evals) + ADR-0012 (shadcn) accepted; TDR gains M-EVAL/M-UI/M-FEAT1 milestones + planned tables; contracts C15–C20 and briefs for P17–P22 written; model policy updated to Opus (5) subagents at max effort with Fable 5 orchestrating. Execution order: **P14.2 (open bug, brief parked) → P17 → P18 → P19‥P22 → P6 → P15/P16.** Owner prerequisite for P17: `ollama pull bge-m3`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | —                                                                                                                                                                                                                                             |
| 2026-08-08 | P14   | opus subagent (abd3a83e)                                                                                        | **Done, DoD verified** (546 tests; UI walked in headless Chrome). `/chat` list + `/chat/:id` conversation, `useAgent` + `useAgentChat` over WS with the ticket flow, collapsible tool-part rendering (search hits become clickable `/entries/:id` cards), suggestion chips, Stop, reconnect. Live: ticket → **WS 101**, real Groq prose turn streamed, reload restored the transcript, list/delete verified, bad token → gate. Corrections to the P13-reported surface: `<Suspense>` is **mandatory** (both hooks resolve via React `use()`), the `query` callback must never reject, and tool parts are read via `getToolPartState/Input/Output` from `@cloudflare/ai-chat/react` (not `ai` types, which don't resolve in `apps/web`). Tool rendering verified by persisting a realistic transcript through the real `/get-messages` path rather than a live model turn — because of the blocker below. Lockfile reconciled (was stale vs `package.json`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | no new deps                                                                                                                                                                                                                                   |
| 2026-08-08 | P14.1 | orchestrator patch                                                                                              | **Done** (core 298→301). P14 hit a hard blocker: **every tool-calling turn failed** with Groq's `Failed to call a function … failed_generation`. Verified as a **known Groq/`llama-3.3-70b-versatile` defect** — the model wraps tool calls in `<function=json>…</function>` instead of emitting pure JSON, and Groq's validator rejects it; widely reported through 2026. Our `streamChat` wiring (`tool()` + `jsonSchema()` + `stopWhen`) is standard and correct. Fixes: (a) `describeChatStreamError` passed to `toUIMessageStreamResponse({onError})` so the failure names the cause and a working model instead of "An error occurred" — also maps rate-limit and auth failures, and never echoes raw provider payloads; (b) Settings model placeholder for Groq changed to `openai/gpt-oss-20b`, which handles both tool calling and strict `json_schema`; (c) README documents the model constraint. **Owner action:** change the model in Settings to use chat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                             |
| 2026-08-08 | P13   | opus subagent (abd228e6)                                                                                        | **Done, DoD verified + LIVE CHAT CONFIRMED** (core 288→298, web 172→229). `streamChat` in `packages/core` (all `ai` imports stay there; `provider.ts` extracted so `create*` guardrail code isn't duplicated), `TilChatAgent extends AIChatAgent` DO with the three read-only tools, `POST /api/chat/ticket` + chat routes, D1 conversation index (`0004_chats.sql`). Live: asked "What have I saved about CSS?" → model called `search_entries` → grounded answer citing the real jvns.ca entry; history persisted; list/delete verified; owner data untouched. **Contract changes accepted:** (a) **C14 revised — there is no HTTP chat endpoint** in `@cloudflare/ai-chat@0.10.1`; chat is **WebSocket-only** via `cf_agent_use_chat_request` frames, routed under `prefix: "api"`. (b) `chatNoticeResponse` added so the no-settings path yields a readable assistant turn instead of an opaque stream error. (c) **`nodejs_compat` re-enabled** — `agents` statically imports `node:async_hooks`/`node:diagnostics_channel` and dev won't boot without it (`nodejs_als` insufficient); bundle 417→811 kB gzip. ADRs 0002/0003/0005/0008 corrected. (d) **WS ticket auth** (60 s HMAC ticket, WS-upgrade-only) after two header-based carriers failed on evidence — documented in ADR-0007; orchestrator security-reviewed: domain-separated HMAC, constant-time compare, expiry bounded both ends. (e) `DELETE` clears messages rather than destroying the DO (`destroy()` can't be awaited before answering 204). Honest gap: real DO lifecycle isn't unit-testable in plain vitest — covered by the live run, no fake test written. | @cloudflare/ai-chat 0.10.1 · agents 0.20.1 · @ai-sdk/react 3.0.248                                                                                                                                                                            |
| 2026-08-04 | P11   | opus subagent (aff6b948)                                                                                        | **Done, DoD verified** (core 288, +58). C12 seams (`Embedder`, `VectorStore`, `StackMode`) + `createOllamaEmbedder` (`/api/embed`, batched, defensively L2-normalized, `EmbeddingError` on HTTP/count/dimension mismatch) + `retrieval.ts` (`rrfMerge` k=60, `cosineSimilarity`, `normalizeVector`, `embeddingTextFor`) + `chat.ts` (C13 `CHAT_SYSTEM_PROMPT` with untrusted-data + read-only clauses, tool schemas). Deviations accepted: chat surface in its own `chat.ts`; `embeddingTextFor` omits empty parts (worker's old version emitted blank lines); extra additive exports (`CHAT_TOOL_DESCRIPTIONS`, topK bounds, `RRF_K`); `embed([])` short-circuits; `rrfMerge` skips non-finite ranks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | no new deps                                                                                                                                                                                                                                   |
| 2026-08-04 | P12   | opus subagent (a81201c8)                                                                                        | **Done, DoD verified + both modes exercised live** (web 78→172). ADR-0010 implemented: `resolveStack(env)` (unset/garbage → `local` with warning), `ReadabilityExtractor` replacing the regex stripper, `WorkersAIEmbedder`, `VectorizeStore` + `D1VectorStore` (migration `0003_vectors.sql`, cascade off `entries`), ingest wired through the seams, hybrid `searchEntries` with **FTS-only degradation when the embedder is unreachable**, `getEntryForTool`, 5 `stats` kinds, `POST /api/entries/reembed` backfill, `/api/health` now reports `{stack, embedder}`. Bundle 285→**417 kB gzip** (~14% of the 3 MiB ceiling) after importing `turndown/lib/turndown.browser.es.js` to drop 82 kB of unused domino. Deviations accepted: regex fallback deleted outright (a silent fallback would defeat the `ExtractionError` contract this phase exists to restore); `top_tags` expanded in TS via the single `parseTags` definition rather than `json_each` (the exact shape that silently returned 0 in M2). Live (Ollama absent): health reports `embedder:'unavailable'` without throwing, ingest still reaches `ready`, search degrades to FTS. Real embed path unverified — Ollama not installed.                                                                                                                                                                                                                                                                                                                                                                                                                                  | @mozilla/readability · linkedom · turndown                                                                                                                                                                                                    |
| 2026-08-04 | P12.1 | orchestrator patch                                                                                              | **Done** (288 core tests still green). Fixed a live defect P12 hit: `MAX_MARKDOWN_CHARS` was 48k chars (~12k tokens), so a long article exceeded Groq's free 12k TPM and the entry **failed outright**. Lowered to 24k (~6k tokens, aligning with the synthesis cap) — a digest of the first ~4,000 words beats no digest.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P9a   | opus subagent (aa9b5b58)                                                                                        | **Done, DoD verified** (core 230 tests, +78). C11 `synthesizeDigest` on both clients, all three dialects; new `SYNTHESIS_*` prompt/schema; `parseSynthesis` drops hallucinated `canonicalUrl`s, de-dupes, truncates to `maxItems`. Prompt cap 24k chars with an explicit "N omitted" note; dates rendered as UTC `YYYY-MM-DD` (no `Date.now()` in core). Deviation accepted: JSON schema omits `minItems`/`maxItems` (OpenAI strict mode rejects them) — bound enforced in `parseSynthesis`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P9b   | opus subagent (a4a052b7)                                                                                        | **Done, DoD verified + LIVE RUN CONFIRMED** (web 74→78 tests). `DigestWorkflow` (WorkflowEntrypoint) with steps plan→fetch-per-source (Promise.allSettled, isolated)→rank→synthesize→persist, per-step retries; weekly cron `0 8 * * 1`; 4 routes per C10. **`vite dev` handled the Workflow binding with no API token — Workflows are fully local, unlike AI/Vectorize.** Live: one real run produced a `ready` digest, 5 ranked items, HN+Lobsters corroboration, one Groq synthesis call. Key decisions: `plan` step freezes `runAt` so retries can't drift the window; digest row id generated in `startDigestRun` before triggering (no 404 window for the UI poll); `persist` deletes existing items first (replay-safe); empty candidate pool → `failed` without an LLM call. Deviations accepted: `workflow_error` code added; `runDigest` returns `{status:'failed'}` rather than throwing. **Trap recorded:** drizzle renders raw `sql` columns unqualified in single-table selects — correlated subquery counts silently returned 0; fixed with leftJoin+groupBy (watch in P11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P10   | opus subagent (a3c293af)                                                                                        | **Done, DoD verified** (isolated client typecheck clean; the 4 errors it saw were P9a's interface landing mid-flight, healed by P9b). Digest list + detail pages, `DigestCard`, `digest-format` helpers, nav entry, "Run now" → 202 → navigate. Polls at 2 s while `pending` (list polls only while a row is pending; detail per C7), stops on terminal state. Smoke-tested via headless Chrome incl. contract-shaped fixtures. Filed two integration gaps — one real, fixed below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P10.1 | orchestrator patch                                                                                              | **Done** (web 78 tests). Fixed the gap P10 found: only the _list_ routes swept stale `pending` rows, so opening a zombie run/ingest directly polled forever. Extracted `sweepStalePending(deps, id?)` for digests and added the id-scoped sweep to **both** detail routes (`/api/digests/:id`, `/api/entries/:id`) + 4 tests (stale→failed, fresh→untouched, both routes).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P7    | opus subagent (a6dabf48, resumed as aca2ab4f)                                                                   | **Done, DoD verified by orchestrator** (core 152 tests; strict greps clean: no `node:` imports, no `DOMParser`, no un-mocked fetch in tests). 4 adapters (`sources/hn                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | lobsters                                                                                                                                                                                                                                      | arxiv | rss.ts`+`http/xml/registry`) + `ranking.ts`. First run died on a transient 529 after writing all implementation but **zero tests**; resumed with a test-only brief → 65 new tests, no impl bugs found. Real values (differ from brief assumptions — treat as the contract now): HN `minPoints`default 50, strict`points>50`; only HN/arXiv push `limit` to the wire (Lobsters/RSS filter client-side); Lobsters URL fallback is 3-step (`url`→`comments_url`→`/s/{short_id}`); scoring = `0.4·recency + 0.4·popularity(log1p, per-source max, 0.5 neutral when absent) + 0.2·corroboration(saturates at 3 sources)`, ties by `canonicalUrl`; title-merge Jaccard ≥0.8 **and** ≥3 tokens both sides; RSS errors two-tier (`rss:<host>`per feed via`onFeedError`, `rss` only when all fail). Default RSS feeds: Cloudflare blog, jvns.ca, simonwillison.net. | fast-xml-parser |
| 2026-08-03 | P8    | opus subagent (a8fb944b)                                                                                        | **Done, DoD verified by orchestrator** (db 16 tests: FK-violation rejection under `PRAGMA foreign_keys=ON`, cascade delete, `(digestId, rank)` ordering, M1 FTS behavior untouched). C8 implemented; migration `0002_digests.sql` with FK cascade + both indexes. **Naming resolved:** row types export as `DigestRun`/`NewDigestRun` + `DigestItem`/`NewDigestItem` (tables `digests`/`digestItems`) to avoid collision with `@til/core`'s per-entry `Digest` — **P9 must use these names.** Also hit the same 529; work was complete before it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P5.3  | orchestrator patch                                                                                              | **Done** (138 tests). Real ingest failed: most Groq models reject `response_format: json_schema` (`llama-3.3-70b-versatile` included). Fix: AI SDK client sets `providerOptions.groq.structuredOutputs = false` and uses the schema-in-prompt system message for Groq — the direct client's proven approach, extracted to a shared `jsonModeSystemPrompt()`. `parseDigest` remains the real validator, so provider-side enforcement is never load-bearing. Regression test asserts the wire body is never `json_schema` and that the system prompt carries the schema. Gateway-token leg confirmed working by this failure (request reached Groq).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P5.2  | opus subagent (ae09f8e3)                                                                                        | **Done, DoD verified by orchestrator** (137 tests; owner's real settings row confirmed intact after the agent's live test — it backed up/restored local D1 unprompted). Settings UX fix driven by a real blocker (owner couldn't add a gateway token without re-typing the provider key). Implements amended C5/ADR-0007: `apiKey` omittable iff `provider`+`cfAccountId`+`cfGatewayId` unchanged (else 422 with explanatory message); `cfAigToken` absent→keep, `""`→clear. UI: key field labelled optional with masked placeholder, amber warning when routing edits make it required again, gateway-token field relabelled `cf-aig-authorization` with clear-token checkbox. Key still never leaves the server (no client-side storage, no pre-fill).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | no new deps                                                                                                                                                                                                                                   |
| 2026-08-03 | P5.1  | opus subagent (ade8b1c0)                                                                                        | **Done, DoD verified by orchestrator** (129 tests total; greps clean). Groq added as third BYOK provider after owner's key turned out to be Groq (free tier) — contract change C4/C5 + TDR/ADR-0002 updated first. Direct client: OpenAI-compatible wire + `json_object` + schema-in-prompt (JSON-mode hint composed per-provider without touching the shared prompt); AISDK client: `createGroq` with gateway baseURL (asserted final URL `…/groq/chat/completions`). Settings UI: Groq option + model placeholder. Owner model guidance: `llama-3.3-70b-versatile` (default), `openai/gpt-oss-*` for strict json_schema. Clarified: CF AI Gateway pass-through is free — the "payment" screen was the optional Unified Billing/stored-keys feature (+5% fee), which we don't use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | @ai-sdk/groq 3.0.55 (exact)                                                                                                                                                                                                                   |
| 2026-08-03 | P5    | orchestrator-led (no subagent — evidence largely existed from P3 transcript + smoke checks)                     | **Machine-verifiable §13 items PASS**: dev stack boots; migrations applied `--local`; live pass: 201→pending→failed-with-real-fetch-reason, 409 duplicate, 400 unsafe (169.254.169.254), 400 invalid, 422 partial settings, 401 no-token, search shape, suites 115/115. **Human leg CONFIRMED 2026-08-03** (owner + orchestrator evidence): Test connection OK through an **Authenticated Gateway** (token required — see P5.2), and the golden path produced a genuine `ready` entry (real title/summary/takeaway/3 tags) via **Groq** `llama-3.3-70b-versatile`; live FTS5 search matched it on words from the takeaway ("documentation", "permission"), proving triggers + search route on real data. Failure paths also exercised organically (404 fetch, unsupported response_format) with readable errors. Provider actually in use: **Groq** (not OpenAI as first planned — free tier). **M1 COMPLETE.** Deferred to P6: delete→Vectorize-vector removal and Workers-AI `toMarkdown` quality (local runs use `DevFallbackExtractor`; bindings off).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                             |
| 2026-08-03 | P3    | opus subagent (a8e2112b)                                                                                        | **Done, DoD verified by orchestrator** (35 worker tests; live curl: health 200 no-auth, 401 without token, 201→pending→failed-with-reason pipeline, 400 unsafe, 409 duplicate + `existingId`, 422 partial settings, masked GET). DI via `createApp(depsFor)`. Deviations accepted: `tsconfig.test.json` split (test harness uses node builtins); typecheck script now REAL (`tsc --build`) — old one was a silent no-op; `drizzle-orm` direct dep on web (pnpm no-hoist); manual XOR length-safe token compare (Workers lack `timingSafeEqual`); `DevFallbackExtractor` when `env.AI` absent (bindings stay commented till P5/P6). Workers-AI shapes recorded: `AI.toMarkdown({name, blob})` → `.data`; `AI.run('@cf/baai/bge-m3',{text})` → `data[0]`. P5 note: run `wrangler d1 migrations apply til --local` on fresh checkouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | zod 4.4.3 · @hono/zod-validator 0.7.5                                                                                                                                                                                                         |
| 2026-08-03 | P4    | opus subagent (a186b672)                                                                                        | **Done after one orchestrator patch.** SPA per C5/C7: token gate (localStorage + 401→gate + cache clear), feed (optimistic pending, 409→navigate, debounced search, infinite scroll), detail (2 s poll while pending, reingest/delete), settings (full-replace form, masked placeholder, test-connection). Patch: `FeedPage` `useInfiniteQuery` 3rd generic fixed to `InfiniteData<EntryListPage>` — P4's "clean typecheck" had run against the old no-op script; caught by P3's real one. Contract notes filed: EntryDTO digest fields are `string\|null` until `ready` (C5 clarified de facto); `existingId` lives at envelope top level. Sign-out button added (accepted).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | no new deps (C7 stack from P0)                                                                                                                                                                                                                |
| 2026-08-03 | P1    | opus subagent (a50a37c1)                                                                                        | **Done, DoD verified by orchestrator** (fresh `--force` runs; 6/6 tests). Migrations: `0000_init.sql`, `0001_fts.sql` (+ drizzle `meta/` — wrangler ignores non-`.sql`). Deviations accepted: `@types/node` devDep (tests only; `src/` stays edge-safe), tsconfig widened to include `test/`. P3 notes: `createDb`/`Db` exported; never split migration SQL on `;` (trigger bodies) — use whole-file exec or `--> statement-breakpoint`; `tags` is a JSON string; ids are caller-supplied `crypto.randomUUID()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | drizzle-orm 0.45.2 · drizzle-kit 0.31.10 · better-sqlite3 13.0.2                                                                                                                                                                              |
| 2026-08-03 | P2    | opus subagent (a45c0ef4)                                                                                        | **Done, DoD verified by orchestrator** (74/74 tests; greps clean: no `ai` imports outside core, no `node:` in core, no plain model strings). Structured output via v6 **Output API** (`generateText` + `Output.object`), zod schemas. Deviations accepted: extra tracker params stripped; `assertSafeUrl` also blocks `0.0.0.0/8` + IPv6 ULA; `canonicalUrl` strips trailing slash (dedupe semantics). P3 notes: Anthropic `baseURL` needs `/anthropic/v1` (SDK appends `/messages`); pass Worker `fetch` via `fetchImpl`; `ping()` never throws; `Digest` strings pre-trimmed/lowercased.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ai 6.0.240 (exact) · @ai-sdk/openai 3.0.90 · @ai-sdk/anthropic 3.0.104 · zod 4.4.3                                                                                                                                                            |
| 2026-08-02 | P0    | opus subagent (a6b2b2b7)                                                                                        | **Done, DoD verified by orchestrator** (fresh `--force` runs + dev-server curl: `/api/health` 200, SPA served). Deviations accepted: `ai`+`vectorize` bindings commented until P3 (see C2 amendment); workers-types over `wrangler types` codegen; separate bare `vitest.config.ts` (CF plugin rejects vitest's `resolve.external` — use `@cloudflare/vitest-pool-workers` when binding-level tests are needed); lib stubs build with `tsc --noEmit` (benign turbo output warnings); `.npmrc` allows esbuild/workerd postinstall (pnpm 10 blocks by default); prettier normalized `docs/**` formatting. Note: `react-router` v8 has no `-dom` package; Tailwind v4 configures via CSS, no config file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | pnpm 10.5.2 · turbo 2.10.8 · ts 5.9.3 · vite 8.2.0 · @cloudflare/vite-plugin 1.50.0 · wrangler 4.118.0 · hono 4.12.33 · react 19.2.8 · react-router 8.3.0 · @tanstack/react-query 5.101.4 · tailwindcss 4.3.3 · vitest 4.1.10 · eslint 9.39.5 |

---

## 7. Change control

- Contract change = edit §2 here + sync [tech-design.md](./tech-design.md)/ADRs in the same commit, then re-brief affected phases.
- New risks discovered during implementation go to TDR §14, not this file.
- This plan is the orchestrator's runbook: future sessions should read **this file + the referenced contract sections only** to dispatch the next phase — reading the whole docs set is not required.
