import {
  defaultAdapters,
  isDigestKind,
  normalizeUrl,
  type Candidate,
  type DigestKind,
  type ScoredCluster,
  type SourceAdapter,
  type SynthesisInput,
} from "@til/core";
import type { DigestEvidenceDTO } from "./dto.js";

export const DEFAULT_WINDOW_DAYS = 7;
export const DEFAULT_MAX_ITEMS = 10;
export const MIN_WINDOW_DAYS = 1;
export const MAX_WINDOW_DAYS = 30;
export const MIN_MAX_ITEMS = 1;
export const MAX_MAX_ITEMS = 25;

/**
 * The monthly report's default window. 30 rather than a calendar month because
 * `windowDays` is the only window this table and the ranking understand, and
 * MAX_WINDOW_DAYS is 30 anyway — "the past month" and "the last 30 days" are the
 * same statement here, and the latter needs no month-length arithmetic.
 */
export const MONTHLY_REPORT_WINDOW_DAYS = 30;

/**
 * Cron expressions from `wrangler.jsonc` `triggers.crons`. The scheduled handler
 * routes on `controller.cron`, which Cloudflare documents as the way to tell
 * multiple schedules apart, and it compares the string verbatim — so these are
 * the single definition of both sides of that comparison and must stay
 * character-for-character identical to wrangler.jsonc, spacing included.
 */
export const WEEKLY_CRON = "0 8 * * 1";
export const MONTHLY_REPORT_CRON = "0 9 1 * *";

/**
 * Which flavour a firing cron asks for. An unrecognized expression falls back to
 * the weekly digest rather than throwing: a cron that fires and produces the
 * wrong-but-useful run beats a cron that fires and silently does nothing, and the
 * only way to get here is a wrangler.jsonc edit that forgot this file.
 */
export function digestKindForCron(cron: string): DigestKind {
  return cron.trim() === MONTHLY_REPORT_CRON ? "monthly-report" : "weekly";
}

/** Falls back to 'weekly' for anything unrecognized, including undefined. */
export function normalizeDigestKind(raw: unknown): DigestKind {
  return isDigestKind(raw) ? raw : "weekly";
}

/** The window a flavour uses when the caller did not name one. */
export function defaultWindowDays(kind: DigestKind): number {
  return kind === "monthly-report"
    ? MONTHLY_REPORT_WINDOW_DAYS
    : DEFAULT_WINDOW_DAYS;
}

// Per-adapter, not global: every source is polled for this many candidates and the
// pool is clustered afterwards.
export const CANDIDATES_PER_SOURCE = 40;

// The LLM sees more clusters than it may keep so it can exercise editorial choice.
export const SYNTHESIS_POOL_MULTIPLIER = 3;
export const SYNTHESIS_POOL_CAP = 30;

export const MAX_EVIDENCE_PER_ITEM = 8;

/**
 * The personalized ranking blend (C18): `blended = 0.6 * base + 0.4 * interest`,
 * where `base` is what `scoreClusters` produced (popularity + recency + corroboration)
 * and `interest` is how close the item sits to the owner's recent saved reading.
 *
 * The base term keeps the majority share deliberately: a digest that only mirrors
 * what you already read stops telling you anything new. 0.4 is enough for a
 * strongly-matching item to climb the pool, not enough to own it.
 */
export const BASE_SCORE_WEIGHT = 0.6;
export const INTEREST_SCORE_WEIGHT = 0.4;

/**
 * How many of the owner's stored entry vectors the interest profile is built
 * from, most recently saved first. Same cap as `REEMBED_MAX_ENTRIES`, for the same
 * reason: it bounds the per-run vector reads, and older reading is a worse
 * description of what you care about this week than the last 200 things you saved.
 */
export const MAX_INTEREST_VECTORS = 200;

export type DigestRunParams = {
  digestId: string;
  windowDays: number;
  maxItems: number;
  /**
   * Which run this is. Carried in the Workflow payload rather than handled by a
   * second Workflow class: the payload already carries everything a run needs to
   * be replayable, so one more field keeps one binding, one instance-id↔row
   * mapping and one set of step retry budgets. Optional so a payload written
   * before 0011 (an instance mid-flight across the deploy) still replays as the
   * weekly run it started as.
   */
  kind?: DigestKind;
  // Set by the trigger so every step (and the digests row) shares one instant.
  now?: number;
};

export interface DigestWorkflowBinding {
  create(options?: {
    id?: string;
    params?: DigestRunParams;
  }): Promise<{ id: string }>;
}

export interface DigestStepConfig {
  retries?: {
    limit: number;
    delay: number | string;
    backoff?: "constant" | "linear" | "exponential";
  };
  timeout?: number | string;
}

export interface DigestStep {
  do<T>(
    name: string,
    config: DigestStepConfig,
    fn: () => Promise<T>,
  ): Promise<T>;
}

export interface AdapterFactoryOptions {
  now: number;
  /**
   * The enabled RSS/Atom feeds for this run, read from D1 (C16). Required, not
   * optional: core's `DEFAULT_RSS_FEEDS` fallback is seed data for migration 0005
   * now, and an accidentally-omitted list must be a type error rather than a
   * silent fall back to the old hardcoded three.
   */
  feeds: readonly string[];
  onFeedError?: (feedUrl: string, error: unknown) => void;
}

export type AdaptersFactory = (opts: AdapterFactoryOptions) => SourceAdapter[];

export interface RankedItem {
  canonicalUrl: string;
  url: string;
  title: string;
  sourceName: string;
  sourceDomain: string;
  sources: string[];
  publishedAt: number;
  /**
   * The base topical score from `scoreClusters`. Personalization never overwrites
   * it — it is what `digest_items.score` has always meant, and the marker in the UI
   * needs the two halves of the blend separately to say which one won.
   */
  score: number;
  /** Max cosine similarity to the interest profile; absent when it did not run. */
  interestScore?: number;
  /** `blendScore(score, interestScore)`; absent when personalization did not run. */
  blendedScore?: number;
  snippet?: string;
  evidence: DigestEvidenceDTO[];
}

// WHY: adapters take `now` as a factory, so a captured instant has to be wrapped —
// otherwise each adapter would call Date.now() and drift the window boundary.
export function createDefaultAdapters(
  opts: AdapterFactoryOptions,
): SourceAdapter[] {
  const now = () => opts.now;
  return defaultAdapters({
    hn: { now },
    lobsters: { now },
    arxiv: { now },
    // WHY: with every feed disabled the RSS adapter is dropped rather than built
    // with an empty list. Both yield zero RSS candidates, but omitting it keeps a
    // dead `fetch-rss` step out of the Workflow, and out of the "all sources
    // failed" arithmetic in fetchCandidates. HN/Lobsters/arXiv still run, so
    // disabling every feed narrows the digest instead of breaking the run.
    rss:
      opts.feeds.length === 0
        ? false
        : { now, feeds: opts.feeds, onFeedError: opts.onFeedError },
  });
}

export function clampWindowDays(
  raw: number | undefined,
  kind: DigestKind = "weekly",
): number {
  return clampInt(
    raw,
    defaultWindowDays(kind),
    MIN_WINDOW_DAYS,
    MAX_WINDOW_DAYS,
  );
}

export function clampMaxItems(raw: number | undefined): number {
  return clampInt(raw, DEFAULT_MAX_ITEMS, MIN_MAX_ITEMS, MAX_MAX_ITEMS);
}

export function synthesisPoolSize(maxItems: number): number {
  return Math.min(SYNTHESIS_POOL_CAP, maxItems * SYNTHESIS_POOL_MULTIPLIER);
}

export function toRankedItems(
  clusters: readonly ScoredCluster[],
  limit: number,
): RankedItem[] {
  const out: RankedItem[] = [];
  for (const cluster of clusters) {
    if (out.length >= limit) break;
    const item = toRankedItem(cluster);
    if (item !== undefined) out.push(item);
  }
  return out;
}

export function toSynthesisInputs(
  ranked: readonly RankedItem[],
): SynthesisInput[] {
  return ranked.map((item) => {
    const input: SynthesisInput = {
      canonicalUrl: item.canonicalUrl,
      title: item.title,
      sources: item.sources,
      publishedAt: item.publishedAt,
      // The model is shown the score the pool was actually ordered by, so its
      // editorial choice and the order it reads the pool in cannot disagree.
      score: rankingScore(item),
    };
    if (item.snippet !== undefined) input.snippet = item.snippet;
    return input;
  });
}

/** What ordering and selection use: the blend when it ran, the base score otherwise. */
export function rankingScore(item: RankedItem): number {
  return item.blendedScore ?? item.score;
}

/** The text an item is embedded as for the interest comparison: title + snippet. */
export function interestTextFor(item: RankedItem): string {
  const snippet = item.snippet?.trim() ?? "";
  return snippet.length > 0
    ? `${item.title.trim()}\n${snippet}`
    : item.title.trim();
}

/**
 * `0.6 * base + 0.4 * interest`. `interest` is clamped to 0..1 first: cosine
 * similarity is defined on -1..1, and a negative maximum ("nothing you saved is
 * even orthogonal to this") is not more informative than 0, while letting it
 * through would drag a blended score below zero and out of the range the base
 * score — and therefore the score column and its formatting — lives in.
 */
export function blendScore(base: number, interest: number): number {
  return (
    BASE_SCORE_WEIGHT * base + INTEREST_SCORE_WEIGHT * clampInterest(interest)
  );
}

export function clampInterest(interest: number): number {
  if (!Number.isFinite(interest)) return 0;
  return Math.min(1, Math.max(0, interest));
}

/**
 * "Interest dominated the blend": the interest term contributed strictly more to
 * the blended score than the base term did, i.e. `0.4 * interest > 0.6 * base`.
 * This is the marker's definition — the item is in the digest more because it
 * resembles your reading than because the internet was loud about it.
 */
export function interestDominates(base: number, interest: number): boolean {
  return (
    INTEREST_SCORE_WEIGHT * clampInterest(interest) > BASE_SCORE_WEIGHT * base
  );
}

/**
 * Attaches the interest half of the blend and re-orders by it. `interests[i]`
 * belongs to `ranked[i]`.
 *
 * The sort is by blended score only, with no explicit tie-break: `Array#sort` is
 * stable, so equal blends keep the base-score order `scoreClusters` produced,
 * which is already deterministic.
 */
export function blendRankedItems(
  ranked: readonly RankedItem[],
  interests: readonly number[],
): RankedItem[] {
  const blended = ranked.map((item, index) => {
    const interest = clampInterest(interests[index] ?? 0);
    return {
      ...item,
      interestScore: interest,
      blendedScore: blendScore(item.score, interest),
    };
  });
  blended.sort((a, b) => b.blendedScore - a.blendedScore);
  return blended;
}

function toRankedItem(cluster: ScoredCluster): RankedItem | undefined {
  let normalized: ReturnType<typeof normalizeUrl>;
  try {
    normalized = normalizeUrl(cluster.canonicalUrl);
  } catch {
    return undefined;
  }

  const item: RankedItem = {
    canonicalUrl: cluster.canonicalUrl,
    url: normalized.url,
    title: cluster.title,
    sourceName: primarySourceName(cluster),
    sourceDomain: normalized.sourceDomain,
    sources: cluster.sources,
    publishedAt: cluster.publishedAt,
    score: cluster.score,
    evidence: toEvidence(cluster.candidates),
  };
  const snippet = firstSnippet(cluster.candidates);
  if (snippet !== undefined) item.snippet = snippet;
  return item;
}

// The loudest hit is the most useful single label; candidates are pre-sorted, so
// ties resolve deterministically.
function primarySourceName(cluster: ScoredCluster): string {
  let best: Candidate | undefined;
  for (const candidate of cluster.candidates) {
    if (best === undefined) {
      best = candidate;
      continue;
    }
    if ((candidate.popularity ?? -1) > (best.popularity ?? -1)) {
      best = candidate;
    }
  }
  return best?.sourceName ?? cluster.sources[0] ?? "unknown";
}

function toEvidence(candidates: readonly Candidate[]): DigestEvidenceDTO[] {
  const seen = new Set<string>();
  const out: DigestEvidenceDTO[] = [];
  for (const candidate of candidates) {
    if (out.length >= MAX_EVIDENCE_PER_ITEM) break;
    const key = `${candidate.sourceName}\u0000${candidate.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: candidate.url,
      sourceName: candidate.sourceName,
      title: candidate.title,
    });
  }
  return out;
}

function firstSnippet(candidates: readonly Candidate[]): string | undefined {
  for (const candidate of candidates) {
    const snippet = candidate.snippet?.trim();
    if (snippet !== undefined && snippet.length > 0) return snippet;
  }
  return undefined;
}

function clampInt(
  raw: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}
