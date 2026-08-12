import {
  clusterCandidates,
  scoreClusters,
  type Candidate,
  type DigestKind,
  type DigestSynthesis,
  type LLMClient,
} from "@til/core";
import { digestItems, digests, settings as settingsTable } from "@til/db";
import type { NewDigestItem } from "@til/db";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import {
  CANDIDATES_PER_SOURCE,
  clampMaxItems,
  clampWindowDays,
  digestKindForCron,
  normalizeDigestKind,
  synthesisPoolSize,
  toRankedItems,
  toSynthesisInputs,
  type DigestRunParams,
  type DigestStep,
  type DigestStepConfig,
  type RankedItem,
} from "./digest.js";
import { personalizeRanked } from "./digest-interest.js";
import {
  collectReportSnapshot,
  reportSkipReason,
  toReportSynthesisInputs,
  type ReportEntrySnapshot,
} from "./digest-report.js";
import { listEnabledFeedUrls } from "./feeds.js";
import { HttpError } from "./http-error.js";
import { toLLMSettings } from "./settings.js";

const PLAN: DigestStepConfig = {
  retries: { limit: 2, delay: "1 second", backoff: "exponential" },
};

// Adapters never retry internally and time out after 10s per request, so the
// retry budget for a flaky source lives here.
const FETCH: DigestStepConfig = {
  retries: { limit: 2, delay: "10 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

const RANK: DigestStepConfig = {
  retries: { limit: 1, delay: "1 second" },
};

/**
 * WHY personalization is its own step rather than part of `rank` (C18):
 *
 * 1. Retry shape. `rank` is pure CPU with a CPU-shaped budget (1 retry, no
 *    timeout). Personalization is network I/O — an embed call plus up to 200 vector
 *    reads — and needs a timeout and a delayed, backed-off retry, the same shape
 *    `fetch-*` and `synthesize` have. One step cannot be both.
 * 2. Not double-billing embeddings. A step's result is memoized durably, so when
 *    `synthesize` or `persist` fails and the instance retries, this step replays
 *    from storage and the embed call is not paid for twice. Folded into `rank` it
 *    would be memoized too — but then a transient embedder fault would re-run
 *    clustering, and a `synthesize` retry would still be free either way, so the
 *    separation costs nothing and buys the finer retry granularity.
 * 3. The frozen-plan property from P19 survives. The interest profile is read
 *    inside the step and its output is durable, so a run that retries an hour later
 *    ranks against the reading it started with, not against whatever was saved in
 *    the meantime — the same guarantee `plan` gives `runAt` and the feed list.
 */
const PERSONALIZE: DigestStepConfig = {
  retries: { limit: 2, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
};

/**
 * The monthly report's only input step: D1 reads of the owner's own saves plus the
 * shared stats aggregations. Retry shape follows `rank` rather than `fetch-*` —
 * it is local database I/O with no network hop and no source that can be flaky —
 * but it gets a second retry because unlike `rank` it can fail for reasons that
 * pass on their own.
 */
const COLLECT: DigestStepConfig = {
  retries: { limit: 2, delay: "1 second", backoff: "exponential" },
  timeout: "1 minute",
};

const SYNTHESIZE: DigestStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

const PERSIST: DigestStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
};

const MARK_FAILED: DigestStepConfig = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" },
};

export interface DigestPlan {
  digestId: string;
  runAt: number;
  windowDays: number;
  maxItems: number;
  kind: DigestKind;
  /**
   * Enabled `feeds` rows at plan time — see planRun for why it is frozen here.
   * Always empty for a monthly report, which reads no external sources at all.
   */
  feeds: string[];
}

export interface DigestRunOutcome {
  digestId: string;
  status: "ready" | "failed";
  itemCount: number;
  error?: string;
}

export interface StartDigestInput {
  windowDays?: number;
  maxItems?: number;
  kind?: DigestKind;
  id?: string;
}

export interface StartedDigestRun {
  id: string;
  runAt: number;
  windowDays: number;
  maxItems: number;
  kind: DigestKind;
}

/**
 * Creates the pending `digests` row and triggers the Workflow with the row id as
 * the instance id, so a 202 always names a row the client can poll and CF
 * instances map 1:1 onto rows.
 */
export async function startDigestRun(
  deps: Deps,
  input: StartDigestInput = {},
): Promise<StartedDigestRun> {
  const workflow = deps.digestWorkflow;
  if (!workflow) {
    throw new HttpError(
      503,
      "workflow_error",
      "Digest runs are unavailable: the DIGEST workflow binding is not configured.",
    );
  }

  const kind = normalizeDigestKind(input.kind);
  const windowDays = clampWindowDays(input.windowDays, kind);
  const maxItems = clampMaxItems(input.maxItems);
  const id = input.id ?? crypto.randomUUID();
  const runAt = deps.now();

  await deps.db.insert(digests).values({
    id,
    runAt,
    windowDays,
    kind,
    status: "pending",
    createdAt: runAt,
    updatedAt: runAt,
  });

  try {
    await workflow.create({
      id,
      params: { digestId: id, windowDays, maxItems, kind, now: runAt },
    });
  } catch (err) {
    const message = describeError(err);
    await deps.db
      .update(digests)
      .set({
        status: "failed",
        error: `could not start the digest workflow: ${message}`,
        updatedAt: deps.now(),
      })
      .where(eq(digests.id, id));
    throw new HttpError(
      502,
      "workflow_error",
      `Could not start the digest workflow: ${message}`,
    );
  }

  return { id, runAt, windowDays, maxItems, kind };
}

/**
 * The cron entry point. Which flavour a schedule asks for is decided from the cron
 * expression alone (see `digestKindForCron`), so this is the whole of the routing
 * and it is testable without a Workers runtime.
 */
export async function startScheduledRun(
  deps: Deps,
  cron: string,
): Promise<StartedDigestRun> {
  return startDigestRun(deps, { kind: digestKindForCron(cron) });
}

export async function runDigest(
  deps: Deps,
  params: DigestRunParams,
  step: DigestStep,
): Promise<DigestRunOutcome> {
  const plan = await step.do("plan", PLAN, () => planRun(deps, params));

  try {
    const persisted =
      plan.kind === "monthly-report"
        ? await runMonthlyReport(deps, plan, step)
        : await runWeeklyDigest(deps, plan, step);
    return {
      digestId: plan.digestId,
      status: "ready",
      itemCount: persisted.itemCount,
    };
  } catch (err) {
    const message = describeError(err);
    console.error(`[digest ${plan.digestId}] failed:`, message);
    await step.do("mark-failed", MARK_FAILED, () =>
      markFailed(deps, plan.digestId, message),
    );
    return {
      digestId: plan.digestId,
      status: "failed",
      itemCount: 0,
      error: message,
    };
  }
}

/** The original path: external candidates, clustered, ranked, personalized. */
async function runWeeklyDigest(
  deps: Deps,
  plan: DigestPlan,
  step: DigestStep,
): Promise<{ itemCount: number }> {
  const pooled = await fetchCandidates(deps, plan, step);
  const ranked = await step.do("rank", RANK, async () =>
    rankCandidates(pooled, plan),
  );
  if (ranked.length === 0) {
    throw new Error(`no candidates found in the last ${plan.windowDays} day(s)`);
  }

  // Ranking and selection use the blend from here on; `ranked` is the fallback
  // the run keeps when personalization does not apply or degrades.
  const pool = (await personalize(deps, plan, ranked, step)) ?? ranked;

  const synthesis = await step.do("synthesize", SYNTHESIZE, () =>
    synthesize(deps, plan, toSynthesisInputs(pool), {}),
  );
  return step.do("persist", PERSIST, () =>
    persist(deps, plan, synthesis, weeklyItemResolver(pool)),
  );
}

/**
 * The monthly retrospective (P26). Same Workflow, same row shape, different input:
 * the owner's own saved entries rather than anything fetched, so there is no
 * fetch, no clustering and no personalization — those exist to find and order
 * things you have not read, and every input here is something you did read.
 *
 * The synthesis and persist steps keep their weekly names and retry budgets so a
 * report and a digest are the same run to the Workflow, and only the middle of the
 * pipeline differs.
 */
async function runMonthlyReport(
  deps: Deps,
  plan: DigestPlan,
  step: DigestStep,
): Promise<{ itemCount: number }> {
  const snapshot = await step.do("collect-entries", COLLECT, () =>
    collectReportSnapshot(deps, {
      runAt: plan.runAt,
      windowDays: plan.windowDays,
    }),
  );

  // An empty month is not a bug, but the row has to end up somewhere terminal or
  // the stale-pending sweep turns it into "digest run timed out" 15 minutes later.
  // Recorded as failed-with-reason rather than a new `skipped` status: the reason
  // is already rendered verbatim by the list card and the detail page, and adding
  // a fourth status would mean a DTO union change that older clients would
  // normalize to "pending" and poll forever.
  const skip = reportSkipReason(snapshot);
  if (skip !== null) throw new Error(skip);

  console.log(
    `[digest ${plan.digestId}] monthly report over ${snapshot.entries.length} saved entr(ies) of ${snapshot.context.saved} in the window`,
  );

  const synthesis = await step.do("synthesize", SYNTHESIZE, () =>
    synthesize(deps, plan, toReportSynthesisInputs(snapshot.entries), {
      kind: "monthly-report",
      report: snapshot.context,
    }),
  );
  return step.do("persist", PERSIST, () =>
    persist(deps, plan, synthesis, reportItemResolver(snapshot.entries)),
  );
}

// WHY: this step exists to freeze `runAt` in durable storage. Every later step and
// every adapter reads it, so retries and replays cannot shift the window. The
// enabled feed list is frozen the same way and for the same reason: a run that
// retries an hour after the owner toggled a feed must still be the run it started
// as, not a half-and-half of two source sets.
async function planRun(
  deps: Deps,
  params: DigestRunParams,
): Promise<DigestPlan> {
  const runAt = params.now ?? deps.now();
  const kind = normalizeDigestKind(params.kind);
  const windowDays = clampWindowDays(params.windowDays, kind);
  const maxItems = clampMaxItems(params.maxItems);
  // A monthly report reads no external sources, so it neither needs the feed list
  // nor should pay a D1 read for one.
  const feeds =
    kind === "monthly-report" ? [] : await listEnabledFeedUrls(deps.db);

  const existing = await deps.db
    .select({ id: digests.id })
    .from(digests)
    .where(eq(digests.id, params.digestId))
    .limit(1);

  if (existing[0]) {
    await deps.db
      .update(digests)
      .set({
        status: "pending",
        error: null,
        windowDays,
        kind,
        updatedAt: runAt,
      })
      .where(eq(digests.id, params.digestId));
  } else {
    await deps.db.insert(digests).values({
      id: params.digestId,
      runAt,
      windowDays,
      kind,
      status: "pending",
      createdAt: runAt,
      updatedAt: runAt,
    });
  }

  return { digestId: params.digestId, runAt, windowDays, maxItems, kind, feeds };
}

async function fetchCandidates(
  deps: Deps,
  plan: DigestPlan,
  step: DigestStep,
): Promise<Candidate[]> {
  const adapters = deps.adapters({
    now: plan.runAt,
    feeds: plan.feeds,
    onFeedError: (feedUrl, error) => {
      console.warn(
        `[digest ${plan.digestId}] feed ${feedUrl} failed:`,
        describeError(error),
      );
    },
  });
  if (adapters.length === 0) {
    throw new Error("no digest sources are configured");
  }

  const names = stepNames(adapters.map((adapter) => adapter.name));
  const settled = await Promise.allSettled(
    adapters.map((adapter, index) =>
      step.do(names[index] ?? `fetch-${index + 1}`, FETCH, () =>
        adapter.fetchCandidates({
          windowDays: plan.windowDays,
          limit: CANDIDATES_PER_SOURCE,
          fetchImpl: deps.fetchImpl,
        }),
      ),
    ),
  );

  const pooled: Candidate[] = [];
  const failures: string[] = [];
  settled.forEach((result, index) => {
    const name = adapters[index]?.name ?? `source-${index + 1}`;
    if (result.status === "fulfilled") {
      pooled.push(...result.value);
      return;
    }
    const message = describeError(result.reason);
    console.warn(`[digest ${plan.digestId}] source ${name} failed:`, message);
    failures.push(`${name}: ${message}`);
  });

  // One dead source must not sink the run; only a total wipeout is fatal.
  if (failures.length === adapters.length) {
    throw new Error(
      `all ${adapters.length} source(s) failed — ${failures.join("; ")}`,
    );
  }
  return pooled;
}

function rankCandidates(
  pooled: readonly Candidate[],
  plan: DigestPlan,
): RankedItem[] {
  const clusters = clusterCandidates([...pooled]);
  const scored = scoreClusters(clusters, {
    now: plan.runAt,
    windowDays: plan.windowDays,
  });
  return toRankedItems(scored, synthesisPoolSize(plan.maxItems));
}

/**
 * Blends the owner's reading into the ranking, or returns null and leaves the base
 * ranking exactly as it was.
 *
 * Degradation is the whole point of this wrapper. The step is not even created when
 * there is no embedder or no vector store, so those runs have the step list they
 * have always had; and when the step does run and fails, its rejection (after the
 * Workflow has spent its retries) is caught here. A digest is still a digest
 * without personalization, so this can never be the reason a run fails.
 */
async function personalize(
  deps: Deps,
  plan: DigestPlan,
  ranked: readonly RankedItem[],
  step: DigestStep,
): Promise<RankedItem[] | null> {
  if (!deps.embedder || !deps.vectorStore) return null;

  try {
    const result = await step.do("personalize", PERSONALIZE, () =>
      personalizeRanked(deps, ranked),
    );
    if (result === null) return null;
    console.log(
      `[digest ${plan.digestId}] ranked ${result.items.length} item(s) against ${result.profileSize} stored vector(s)`,
    );
    return result.items;
  } catch (err) {
    console.warn(
      `[digest ${plan.digestId}] personalization failed (non-fatal, ranking stays topical):`,
      describeError(err),
    );
    return null;
  }
}

/**
 * Both flavours go through one `synthesizeDigest` call. The LLM settings lookup and
 * its readable failure are shared deliberately: a missing-settings monthly report
 * must fail with the same sentence as a missing-settings weekly digest.
 */
async function synthesize(
  deps: Deps,
  plan: DigestPlan,
  inputs: Parameters<LLMClient["synthesizeDigest"]>[0],
  flavour: Omit<
    Parameters<LLMClient["synthesizeDigest"]>[1],
    "windowDays" | "maxItems"
  >,
) {
  const rows = await deps.db.select().from(settingsTable).limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      "settings not configured — save LLM settings before running a digest",
    );
  }
  const llm = deps.llmFactory(toLLMSettings(row));
  return llm.synthesizeDigest(inputs, {
    windowDays: plan.windowDays,
    maxItems: plan.maxItems,
    ...flavour,
  });
}

/**
 * The columns a flavour decides for itself. Everything else about a
 * `digest_items` row — id, rank, `why`, createdAt — is the same either way and is
 * filled in by `persist`.
 */
type ResolvedItem = Omit<
  NewDigestItem,
  "id" | "digestId" | "rank" | "why" | "createdAt"
>;

/** Turns one synthesis draft into a row, or null when it names nothing we sent. */
type ItemResolver = (
  draft: DigestSynthesis["items"][number],
) => ResolvedItem | null;

function weeklyItemResolver(pool: readonly RankedItem[]): ItemResolver {
  const byUrl = new Map(pool.map((item) => [item.canonicalUrl, item]));
  return (draft) => {
    const source = byUrl.get(draft.canonicalUrl);
    if (!source) return null;
    const title = draft.title.trim();
    return {
      title: title.length > 0 ? title : source.title,
      url: source.url,
      sourceName: source.sourceName,
      sourceDomain: source.sourceDomain,
      score: source.score,
      // Null, not 0, when personalization did not run — see migration 0006.
      interestScore: source.interestScore ?? null,
      evidence: JSON.stringify(source.evidence),
    };
  };
}

/**
 * `sourceName` for a highlighted save. The literal "saved" rather than a feed or
 * aggregator name, because that is the honest answer to "where did this come from"
 * for a report: the owner's own library.
 */
export const REPORT_ITEM_SOURCE_NAME = "saved";

/**
 * `score` is 0 and `evidence` empty because a report has neither — nothing ranked
 * these and no other source corroborated them. The detail page hides the score
 * chip for this kind rather than rendering a meaningless "score 0.00".
 */
function reportItemResolver(
  pool: readonly ReportEntrySnapshot[],
): ItemResolver {
  const byUrl = new Map(pool.map((entry) => [entry.canonicalUrl, entry]));
  return (draft) => {
    const source = byUrl.get(draft.canonicalUrl);
    if (!source) return null;
    const title = draft.title.trim();
    return {
      title: title.length > 0 ? title : source.title,
      url: source.url,
      sourceName: REPORT_ITEM_SOURCE_NAME,
      sourceDomain: source.sourceDomain,
      score: 0,
      interestScore: null,
      evidence: "[]",
    };
  };
}

async function persist(
  deps: Deps,
  plan: DigestPlan,
  synthesis: DigestSynthesis,
  resolve: ItemResolver,
): Promise<{ itemCount: number }> {
  const createdAt = deps.now();

  const rows: NewDigestItem[] = [];
  for (const draft of synthesis.items) {
    const resolved = resolve(draft);
    if (resolved === null) continue;
    const why = draft.why.trim();
    rows.push({
      id: crypto.randomUUID(),
      digestId: plan.digestId,
      rank: rows.length + 1,
      ...resolved,
      why: why.length > 0 ? why : null,
      createdAt,
    });
  }

  // Replays and retries must not stack duplicate items onto the same run.
  await deps.db
    .delete(digestItems)
    .where(eq(digestItems.digestId, plan.digestId));
  // D1 caps a statement at 100 bound parameters, and every row binds one
  // parameter per column — a single multi-row insert of the default 10 items
  // exceeded the cap in production (tests run on better-sqlite3, whose limit
  // is ~32k, so only real D1 ever failed). Chunk size derives from the actual
  // column count so adding a column shrinks the chunk instead of reviving the
  // bug.
  for (const chunk of chunkForD1Insert(rows)) {
    await deps.db.insert(digestItems).values(chunk);
  }
  await deps.db
    .update(digests)
    .set({
      status: "ready",
      title: synthesis.title,
      intro: synthesis.intro,
      error: null,
      updatedAt: createdAt,
    })
    .where(eq(digests.id, plan.digestId));

  return { itemCount: rows.length };
}

async function markFailed(
  deps: Deps,
  digestId: string,
  message: string,
): Promise<{ ok: true }> {
  await deps.db
    .update(digests)
    .set({ status: "failed", error: message, updatedAt: deps.now() })
    .where(eq(digests.id, digestId));
  return { ok: true };
}

// Step names are the memoization key, so duplicates across parallel steps would
// make replays ambiguous.
function stepNames(sources: readonly string[]): string[] {
  const used = new Set<string>();
  return sources.map((source, index) => {
    const base = `fetch-${source}`;
    const name = used.has(base) ? `${base}-${index + 1}` : base;
    used.add(name);
    return name;
  });
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** D1's documented ceiling on bound parameters in a single statement. */
export const D1_MAX_BOUND_PARAMS = 100;

/**
 * Split rows for a multi-row insert so every statement stays within D1's
 * bound-parameter cap. Each row binds one parameter per column, and the count
 * is read off the rows themselves rather than hardcoded, so adding a column
 * shrinks the chunk instead of silently reintroducing the overflow.
 */
export function chunkForD1Insert<T extends object>(rows: T[]): T[][] {
  const first = rows[0];
  if (first === undefined) return [];
  const paramsPerRow = Math.max(1, Object.keys(first).length);
  const size = Math.max(1, Math.floor(D1_MAX_BOUND_PARAMS / paramsPerRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}
