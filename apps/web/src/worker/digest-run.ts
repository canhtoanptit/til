import {
  clusterCandidates,
  scoreClusters,
  type Candidate,
  type DigestSynthesis,
} from "@til/core";
import { digestItems, digests, settings as settingsTable } from "@til/db";
import type { NewDigestItem } from "@til/db";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import {
  CANDIDATES_PER_SOURCE,
  clampMaxItems,
  clampWindowDays,
  synthesisPoolSize,
  toRankedItems,
  toSynthesisInputs,
  type DigestRunParams,
  type DigestStep,
  type DigestStepConfig,
  type RankedItem,
} from "./digest.js";
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
  id?: string;
}

export interface StartedDigestRun {
  id: string;
  runAt: number;
  windowDays: number;
  maxItems: number;
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

  const windowDays = clampWindowDays(input.windowDays);
  const maxItems = clampMaxItems(input.maxItems);
  const id = input.id ?? crypto.randomUUID();
  const runAt = deps.now();

  await deps.db.insert(digests).values({
    id,
    runAt,
    windowDays,
    status: "pending",
    createdAt: runAt,
    updatedAt: runAt,
  });

  try {
    await workflow.create({
      id,
      params: { digestId: id, windowDays, maxItems, now: runAt },
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

  return { id, runAt, windowDays, maxItems };
}

export async function runDigest(
  deps: Deps,
  params: DigestRunParams,
  step: DigestStep,
): Promise<DigestRunOutcome> {
  const plan = await step.do("plan", PLAN, () => planRun(deps, params));

  try {
    const pooled = await fetchCandidates(deps, plan, step);
    const ranked = await step.do("rank", RANK, async () =>
      rankCandidates(pooled, plan),
    );
    if (ranked.length === 0) {
      throw new Error(
        `no candidates found in the last ${plan.windowDays} day(s)`,
      );
    }

    const synthesis = await step.do("synthesize", SYNTHESIZE, () =>
      synthesize(deps, plan, ranked),
    );
    const persisted = await step.do("persist", PERSIST, () =>
      persist(deps, plan, ranked, synthesis),
    );
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

// WHY: this step exists to freeze `runAt` in durable storage. Every later step and
// every adapter reads it, so retries and replays cannot shift the window.
async function planRun(
  deps: Deps,
  params: DigestRunParams,
): Promise<DigestPlan> {
  const runAt = params.now ?? deps.now();
  const windowDays = clampWindowDays(params.windowDays);
  const maxItems = clampMaxItems(params.maxItems);

  const existing = await deps.db
    .select({ id: digests.id })
    .from(digests)
    .where(eq(digests.id, params.digestId))
    .limit(1);

  if (existing[0]) {
    await deps.db
      .update(digests)
      .set({ status: "pending", error: null, windowDays, updatedAt: runAt })
      .where(eq(digests.id, params.digestId));
  } else {
    await deps.db.insert(digests).values({
      id: params.digestId,
      runAt,
      windowDays,
      status: "pending",
      createdAt: runAt,
      updatedAt: runAt,
    });
  }

  return { digestId: params.digestId, runAt, windowDays, maxItems };
}

async function fetchCandidates(
  deps: Deps,
  plan: DigestPlan,
  step: DigestStep,
): Promise<Candidate[]> {
  const adapters = deps.adapters({
    now: plan.runAt,
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

async function synthesize(
  deps: Deps,
  plan: DigestPlan,
  ranked: readonly RankedItem[],
) {
  const rows = await deps.db.select().from(settingsTable).limit(1);
  const row = rows[0];
  if (!row) {
    throw new Error(
      "settings not configured — save LLM settings before running a digest",
    );
  }
  const llm = deps.llmFactory(toLLMSettings(row));
  return llm.synthesizeDigest(toSynthesisInputs(ranked), {
    windowDays: plan.windowDays,
    maxItems: plan.maxItems,
  });
}

async function persist(
  deps: Deps,
  plan: DigestPlan,
  ranked: readonly RankedItem[],
  synthesis: DigestSynthesis,
): Promise<{ itemCount: number }> {
  const byUrl = new Map(ranked.map((item) => [item.canonicalUrl, item]));
  const createdAt = deps.now();

  const rows: NewDigestItem[] = [];
  for (const draft of synthesis.items) {
    const source = byUrl.get(draft.canonicalUrl);
    if (!source) continue;
    const title = draft.title.trim();
    const why = draft.why.trim();
    rows.push({
      id: crypto.randomUUID(),
      digestId: plan.digestId,
      rank: rows.length + 1,
      title: title.length > 0 ? title : source.title,
      url: source.url,
      sourceName: source.sourceName,
      sourceDomain: source.sourceDomain,
      score: source.score,
      why: why.length > 0 ? why : null,
      evidence: JSON.stringify(source.evidence),
      createdAt,
    });
  }

  // Replays and retries must not stack duplicate items onto the same run.
  await deps.db
    .delete(digestItems)
    .where(eq(digestItems.digestId, plan.digestId));
  if (rows.length > 0) {
    await deps.db.insert(digestItems).values(rows);
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
