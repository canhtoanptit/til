import { entries, reviews } from "@til/db";
import { and, count, desc, eq, gte } from "drizzle-orm";
import type { ReportContext, SynthesisInput } from "@til/core";
import type { Deps } from "./deps.js";
import { parseTags } from "./dto.js";
import { stats } from "./retrieval.js";

const DAY_MS = 86_400_000;

/**
 * How many saved entries the report's prompt pool may hold. The prompt builder
 * also enforces a character budget, so this is the cheaper of the two limits: it
 * bounds the D1 read and the JSON we carry through a durable Workflow step.
 * 200 is the same bound `MAX_INTEREST_VECTORS` uses, for the same reason — a
 * month of heavy reading is well inside it, and a month with more than 200 saves
 * does not become a better retrospective by showing the model all of them.
 */
export const MAX_REPORT_ENTRIES = 200;

/** How many domains/tags the retrospective is told about. */
export const MAX_REPORT_TOP_ROWS = 8;

export interface ReportEntrySnapshot {
  id: string;
  canonicalUrl: string;
  url: string;
  title: string;
  sourceDomain: string;
  takeaway: string | null;
  tags: string[];
  savedAt: number;
}

export interface ReportSnapshot {
  /** Inclusive lower bound of the window, in epoch ms. */
  since: number;
  /**
   * The pool the model may write about: `ready` entries saved in the window, most
   * recently saved first. Deliberately narrower than `context.saved` — a pending
   * or failed entry has no takeaway and usually no title, so it can be counted but
   * not written about.
   */
  entries: ReportEntrySnapshot[];
  context: ReportContext;
}

/**
 * Reads the month the report is about. Everything here is derived from a single
 * frozen instant, never `deps.now()`: the aggregates go through the chat `stats`
 * tool's aggregations (so a number in the report can never disagree with the same
 * number in a chat answer) and those are `sinceDays`-relative to `deps.now()`, so
 * the clock is pinned to the plan's `runAt` first. Without that, a Workflow retry
 * an hour later would report on a slightly different month than it planned.
 */
export async function collectReportSnapshot(
  deps: Deps,
  opts: { runAt: number; windowDays: number },
): Promise<ReportSnapshot> {
  const pinned: Deps = { ...deps, now: () => opts.runAt };
  const since = opts.runAt - opts.windowDays * DAY_MS;

  const [totals, domains, tags, reviewsGraded, pool] = await Promise.all([
    stats(pinned, { kind: "totals", sinceDays: opts.windowDays }),
    stats(pinned, { kind: "top_domains", sinceDays: opts.windowDays }),
    stats(pinned, { kind: "top_tags", sinceDays: opts.windowDays }),
    countReviewsGraded(deps, since),
    readEntryPool(deps, since),
  ]);

  const totalsRow = totals.rows[0];
  const context: ReportContext = {
    saved: numberAt(totalsRow, "entries"),
    ready: numberAt(totalsRow, "ready"),
    pending: numberAt(totalsRow, "pending"),
    failed: numberAt(totalsRow, "failed"),
    topDomains: domains.rows.slice(0, MAX_REPORT_TOP_ROWS).map((row) => ({
      domain: String(row.domain ?? ""),
      count: Number(row.count ?? 0),
    })),
    topTags: tags.rows.slice(0, MAX_REPORT_TOP_ROWS).map((row) => ({
      tag: String(row.tag ?? ""),
      count: Number(row.count ?? 0),
    })),
    reviewsGraded,
  };

  return { since, entries: pool, context };
}

/**
 * The report's `SynthesisInput`s. `publishedAt` carries the saved-at instant and
 * `snippet` the owner's takeaway — see the per-flavour notes on `SynthesisInput`.
 * No `score`: the report has no ranking, and the order below is recency only.
 */
export function toReportSynthesisInputs(
  pool: readonly ReportEntrySnapshot[],
): SynthesisInput[] {
  return pool.map((entry) => {
    const input: SynthesisInput = {
      canonicalUrl: entry.canonicalUrl,
      title: entry.title,
      sources: entry.sourceDomain.length > 0 ? [entry.sourceDomain] : [],
      publishedAt: entry.savedAt,
    };
    if (entry.takeaway !== null && entry.takeaway.trim().length > 0) {
      input.snippet = entry.takeaway;
    }
    if (entry.tags.length > 0) input.tags = entry.tags;
    return input;
  });
}

/**
 * Why the month cannot be reported on, or null when it can. Two distinguishable
 * empty months: nothing saved at all, and saves that never finished processing.
 * Both are graceful skips rather than bugs, so the wording has to say which.
 */
export function reportSkipReason(snapshot: ReportSnapshot): string | null {
  if (snapshot.entries.length > 0) return null;
  if (snapshot.context.saved === 0) {
    return "no entries were saved in this window — nothing to report on yet";
  }
  return `${snapshot.context.saved} entr${
    snapshot.context.saved === 1 ? "y was" : "ies were"
  } saved in this window but none finished processing, so there is nothing to report on`;
}

async function readEntryPool(
  deps: Deps,
  since: number,
): Promise<ReportEntrySnapshot[]> {
  const rows = await deps.db
    .select({
      id: entries.id,
      canonicalUrl: entries.canonicalUrl,
      url: entries.url,
      title: entries.title,
      sourceDomain: entries.sourceDomain,
      takeaway: entries.takeaway,
      tags: entries.tags,
      createdAt: entries.createdAt,
    })
    .from(entries)
    .where(and(gte(entries.createdAt, since), eq(entries.status, "ready")))
    // Recency, and `id` after it so a batch of entries saved in the same
    // millisecond cannot reorder between a run and its replay.
    .orderBy(desc(entries.createdAt), desc(entries.id))
    .limit(MAX_REPORT_ENTRIES);

  return rows.map((row) => ({
    id: row.id,
    canonicalUrl: row.canonicalUrl,
    url: row.url,
    // A ready entry always has a title, but the column is nullable, and an
    // untitled item in a report should read as its URL rather than as blank.
    title: row.title?.trim() ? row.title.trim() : row.url,
    sourceDomain: row.sourceDomain ?? "",
    takeaway: row.takeaway ?? null,
    tags: parseTags(row.tags),
    savedAt: row.createdAt,
  }));
}

async function countReviewsGraded(deps: Deps, since: number): Promise<number> {
  // Cheap enough to be worth including: one indexed-ish scan of a table with one
  // row per entry. `count()` renders `count(*)`, which has no column to resolve,
  // so it sidesteps the unqualified-raw-column trap documented in retrieval.ts.
  const rows = await deps.db
    .select({ n: count() })
    .from(reviews)
    .where(gte(reviews.reviewedAt, since));
  return Number(rows[0]?.n ?? 0);
}

function numberAt(
  row: Record<string, string | number> | undefined,
  key: string,
): number {
  const value = row?.[key];
  return typeof value === "number" ? value : Number(value ?? 0);
}
