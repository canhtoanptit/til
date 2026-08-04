import { entries } from "@til/db";
import type { Entry } from "@til/db";
import { and, count, eq, gte, inArray, like, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import {
  CHAT_SEARCH_DEFAULT_TOP_K,
  CHAT_SEARCH_MAX_TOP_K,
  rrfMerge,
} from "@til/core";
import type { StatsKind } from "@til/core";
import type { Deps } from "./deps.js";
import { parseTags } from "./dto.js";
import { sanitizeFtsQuery } from "./search.js";

export const CANDIDATE_POOL_MULTIPLIER = 2;
export const MAX_STATS_ROWS = 52;
export const MAX_TOP_ROWS = 25;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SearchOptions {
  query: string;
  topK?: number;
  tag?: string;
  sinceDays?: number;
}

export interface SearchResultItem {
  id: string;
  title: string | null;
  url: string;
  sourceDomain: string | null;
  takeaway: string | null;
  tags: string[];
  createdAt: number;
  score: number;
}

export interface EntryForTool {
  id: string;
  title: string | null;
  url: string;
  summary: string | null;
  takeaway: string | null;
  question: string | null;
  tags: string[];
  createdAt: number;
}

export interface StatsOptions {
  kind: StatsKind;
  sinceDays?: number;
}

export type StatsRow = Record<string, string | number>;

export interface StatsResult {
  kind: StatsKind;
  rows: StatsRow[];
}

export interface ScoredEntry {
  row: Entry;
  score: number;
}

export function clampTopK(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw))
    return CHAT_SEARCH_DEFAULT_TOP_K;
  return Math.min(CHAT_SEARCH_MAX_TOP_K, Math.max(1, Math.trunc(raw)));
}

/**
 * Hybrid retrieval: the semantic and keyword legs each produce a ranked list of
 * entry ids, RRF fuses them, and the survivors are hydrated from D1 in fused
 * order. When the embedder is unavailable (Ollama down, no AI binding) the
 * semantic leg contributes nothing and this degrades to FTS-only.
 */
export async function searchEntryRows(
  deps: Deps,
  opts: SearchOptions,
): Promise<ScoredEntry[]> {
  const topK = clampTopK(opts.topK);
  const pool = topK * CANDIDATE_POOL_MULTIPLIER;

  const [semantic, keyword] = await Promise.all([
    semanticRanks(deps, opts.query, pool),
    keywordRanks(deps, opts.query, pool, ftsFilters(deps, opts)),
  ]);
  if (semantic.length === 0 && keyword.length === 0) return [];

  const fused = rrfMerge([semantic, keyword]);
  const ids = fused.map((hit) => hit.id);
  if (ids.length === 0) return [];

  // The filters are re-applied here because the semantic leg cannot pre-filter:
  // VectorStore.query takes no metadata predicate.
  const filters = hydrationFilters(deps, opts);
  const where =
    filters.length > 0
      ? and(inArray(entries.id, ids), ...filters)
      : inArray(entries.id, ids);
  const rows = await deps.db.select().from(entries).where(where);

  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: ScoredEntry[] = [];
  for (const hit of fused) {
    if (out.length >= topK) break;
    const row = byId.get(hit.id);
    if (row === undefined) continue;
    out.push({ row, score: hit.score });
  }
  return out;
}

export async function searchEntries(
  deps: Deps,
  opts: SearchOptions,
): Promise<{ items: SearchResultItem[] }> {
  const scored = await searchEntryRows(deps, opts);
  return {
    items: scored.map(({ row, score }) => ({
      id: row.id,
      title: row.title ?? null,
      url: row.url,
      sourceDomain: row.sourceDomain ?? null,
      takeaway: row.takeaway ?? null,
      tags: parseTags(row.tags),
      createdAt: row.createdAt,
      score,
    })),
  };
}

/** Deliberately omits `contentMarkdown`: whole articles blow the chat budget. */
export async function getEntryForTool(
  deps: Deps,
  opts: { id: string },
): Promise<EntryForTool | null> {
  const rows = await deps.db
    .select({
      id: entries.id,
      title: entries.title,
      url: entries.url,
      summary: entries.summary,
      takeaway: entries.takeaway,
      question: entries.question,
      tags: entries.tags,
      createdAt: entries.createdAt,
    })
    .from(entries)
    .where(eq(entries.id, opts.id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title ?? null,
    url: row.url,
    summary: row.summary ?? null,
    takeaway: row.takeaway ?? null,
    question: row.question ?? null,
    tags: parseTags(row.tags),
    createdAt: row.createdAt,
  };
}

export async function stats(
  deps: Deps,
  opts: StatsOptions,
): Promise<StatsResult> {
  const since = sinceCutoff(deps, opts.sinceDays);
  switch (opts.kind) {
    case "totals":
      return { kind: opts.kind, rows: await totalsRows(deps, since) };
    case "per_week":
      return { kind: opts.kind, rows: await perWeekRows(deps, since) };
    case "top_tags":
      return { kind: opts.kind, rows: await topTagRows(deps, since) };
    case "top_domains":
      return { kind: opts.kind, rows: await topDomainRows(deps, since) };
    case "streak":
      return { kind: opts.kind, rows: await streakRows(deps, since) };
  }
}

async function semanticRanks(
  deps: Deps,
  query: string,
  pool: number,
): Promise<{ id: string; rank: number }[]> {
  const { embedder, vectorStore } = deps;
  if (!embedder || !vectorStore) return [];
  if (query.trim().length === 0) return [];
  try {
    const [values] = await embedder.embed([query]);
    if (!values) return [];
    const matches = await vectorStore.query(values, { topK: pool });
    return matches.map((match, index) => ({ id: match.id, rank: index + 1 }));
  } catch (err) {
    // WHY: a missing embedder must not fail search — hybrid degrades to FTS-only.
    console.warn(
      "[search] semantic leg unavailable, falling back to FTS-only:",
      err instanceof Error ? err.message : String(err),
    );
    return [];
  }
}

async function keywordRanks(
  deps: Deps,
  query: string,
  pool: number,
  filters: SQL[],
): Promise<{ id: string; rank: number }[]> {
  const clean = sanitizeFtsQuery(query);
  if (!clean) return [];
  // WHY: FTS5 needs its own MATCH join, so this leg is raw SQL. `e.*` columns are
  // spelled with the alias so nothing resolves against entries_fts by accident.
  const predicates = filters.map((filter) => sql` AND ${filter}`);
  const rows = await deps.db.all<{ id: string }>(
    sql`
      SELECT e.id AS id FROM entries e
      JOIN entries_fts f ON f.rowid = e.rowid
      WHERE entries_fts MATCH ${clean}${sql.join(predicates, sql``)}
      ORDER BY rank
      LIMIT ${pool}
    `,
  );
  return rows.map((row, index) => ({ id: row.id, rank: index + 1 }));
}

// Spelled with the FTS leg's `e.` alias so nothing can resolve against
// entries_fts, which exposes columns of the same name.
function ftsFilters(deps: Deps, opts: SearchOptions): SQL[] {
  const filters: SQL[] = [];
  const since = sinceCutoff(deps, opts.sinceDays);
  if (since !== null) filters.push(sql`e.created_at >= ${since}`);
  const tag = normalizeTag(opts.tag);
  if (tag !== null) filters.push(sql`e.tags LIKE ${tagPattern(tag)}`);
  return filters;
}

// Drizzle operators rather than raw `sql` here: raw columns render unqualified,
// which is the shape that silently mis-resolved in M2.
function hydrationFilters(deps: Deps, opts: SearchOptions): SQL[] {
  const filters: SQL[] = [];
  const since = sinceCutoff(deps, opts.sinceDays);
  if (since !== null) filters.push(gte(entries.createdAt, since));
  const tag = normalizeTag(opts.tag);
  if (tag !== null) filters.push(like(entries.tags, tagPattern(tag)));
  return filters;
}

/**
 * `tags` is a JSON array of strings, so an exact tag is the substring `"tag"`,
 * quotes included — `"rust"` cannot match `"rustlang"`. Chosen over
 * `json_each` because a correlated subquery is exactly where drizzle's
 * unqualified raw-column rendering bit us in M2.
 */
function tagPattern(tag: string): string {
  return `%"${tag}"%`;
}

function normalizeTag(raw: string | undefined): string | null {
  if (typeof raw !== "string") return null;
  // Quotes and backslashes cannot appear in a real tag and would break the JSON
  // substring match; LIKE wildcards would widen it.
  const cleaned = raw.trim().replace(/["\\%_]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function sinceCutoff(deps: Deps, sinceDays: number | undefined): number | null {
  if (sinceDays === undefined || !Number.isFinite(sinceDays)) return null;
  const days = Math.trunc(sinceDays);
  if (days <= 0) return null;
  return deps.now() - days * DAY_MS;
}

async function totalsRows(
  deps: Deps,
  since: number | null,
): Promise<StatsRow[]> {
  // WHY (M2 trap): a raw correlated `count(*)` renders unqualified in a
  // single-table select and silently returns 0 — group by status instead.
  const rows = await deps.db
    .select({ status: entries.status, n: count() })
    .from(entries)
    .where(since === null ? undefined : gte(entries.createdAt, since))
    .groupBy(entries.status);

  const byStatus = new Map<string, number>();
  let total = 0;
  for (const row of rows) {
    byStatus.set(row.status, row.n);
    total += row.n;
  }
  return [
    {
      entries: total,
      ready: byStatus.get("ready") ?? 0,
      pending: byStatus.get("pending") ?? 0,
      failed: byStatus.get("failed") ?? 0,
    },
  ];
}

async function perWeekRows(
  deps: Deps,
  since: number | null,
): Promise<StatsRow[]> {
  const rows = await deps.db
    .select({ createdAt: entries.createdAt })
    .from(entries)
    .where(since === null ? undefined : gte(entries.createdAt, since));

  const counts = new Map<string, number>();
  for (const row of rows) {
    const week = isoWeek(row.createdAt);
    counts.set(week, (counts.get(week) ?? 0) + 1);
  }
  const out: StatsRow[] = [];
  for (const [week, n] of counts) out.push({ week, count: n });
  // Newest week first, matching every other listing in the app.
  out.sort((a, b) => String(b.week).localeCompare(String(a.week)));
  return out.slice(0, MAX_STATS_ROWS);
}

async function topTagRows(
  deps: Deps,
  since: number | null,
): Promise<StatsRow[]> {
  // WHY TS and not `json_each`: `parseTags` is already the single definition of
  // how the JSON column is read everywhere else, so counting here cannot drift
  // from what the API returns, and it needs no JSON1 or subquery.
  const rows = await deps.db
    .select({ tags: entries.tags })
    .from(entries)
    .where(since === null ? undefined : gte(entries.createdAt, since));

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const out: StatsRow[] = [];
  for (const [tag, n] of counts) out.push({ tag, count: n });
  out.sort(
    (a, b) =>
      Number(b.count) - Number(a.count) ||
      String(a.tag).localeCompare(String(b.tag)),
  );
  return out.slice(0, MAX_TOP_ROWS);
}

async function topDomainRows(
  deps: Deps,
  since: number | null,
): Promise<StatsRow[]> {
  const rows = await deps.db
    .select({ domain: entries.sourceDomain, n: count() })
    .from(entries)
    .where(since === null ? undefined : gte(entries.createdAt, since))
    .groupBy(entries.sourceDomain);

  const out: StatsRow[] = [];
  for (const row of rows) {
    const domain = row.domain ?? "";
    if (domain.length === 0) continue;
    out.push({ domain, count: row.n });
  }
  out.sort(
    (a, b) =>
      Number(b.count) - Number(a.count) ||
      String(a.domain).localeCompare(String(b.domain)),
  );
  return out.slice(0, MAX_TOP_ROWS);
}

async function streakRows(
  deps: Deps,
  since: number | null,
): Promise<StatsRow[]> {
  const rows = await deps.db
    .select({ createdAt: entries.createdAt })
    .from(entries)
    .where(since === null ? undefined : gte(entries.createdAt, since));

  const days = new Set<number>();
  for (const row of rows) days.add(utcDayIndex(row.createdAt));
  if (days.size === 0) {
    return [{ currentDays: 0, longestDays: 0, activeDays: 0, lastSavedOn: "" }];
  }

  const sorted = [...days].sort((a, b) => a - b);
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i += 1) {
    run = (sorted[i] ?? 0) - (sorted[i - 1] ?? 0) === 1 ? run + 1 : 1;
    if (run > longest) longest = run;
  }

  // A streak counts from today; a gap of more than one day has already broken it.
  const today = utcDayIndex(deps.now());
  const last = sorted[sorted.length - 1] ?? 0;
  let current = 0;
  if (today - last <= 1) {
    current = 1;
    for (let i = sorted.length - 1; i > 0; i -= 1) {
      if ((sorted[i] ?? 0) - (sorted[i - 1] ?? 0) !== 1) break;
      current += 1;
    }
  }

  return [
    {
      currentDays: current,
      longestDays: longest,
      activeDays: sorted.length,
      lastSavedOn: utcDate(last * DAY_MS),
    },
  ];
}

function utcDayIndex(ms: number): number {
  return Math.floor(ms / DAY_MS);
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO-8601 week label, e.g. `2026-W31`. */
export function isoWeek(ms: number): string {
  const date = new Date(ms);
  const target = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // Thursday of the current ISO week decides which year the week belongs to.
  const dayOfWeek = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayOfWeek + 3);
  const isoYear = target.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayOfWeek = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayOfWeek + 3);
  const week =
    1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * DAY_MS));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}
