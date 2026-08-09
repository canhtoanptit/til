import { sql } from "drizzle-orm";
import { RRF_K, rrfMerge } from "@til/core";
import type { RankedId } from "@til/core";
import type { EvalStack } from "./runner.js";

export type RetrievalMode = "fts" | "vector" | "hybrid";

export const RETRIEVAL_MODES: readonly RetrievalMode[] = [
  "fts",
  "vector",
  "hybrid",
];

export interface RetrievalConfig {
  topK: number;
  /** Candidates each leg fetches, as a multiple of topK. */
  poolMultiplier: number;
  rrfK: number;
}

/**
 * The production defaults this suite exists to question: `topK` from
 * `CHAT_SEARCH_DEFAULT_TOP_K`, the multiplier from `CANDIDATE_POOL_MULTIPLIER`
 * and `rrfK` from core's `RRF_K`.
 */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 8,
  poolMultiplier: 2,
  rrfK: RRF_K,
};

/**
 * Verbatim copy of `sanitizeFtsQuery` in `apps/web/src/worker/search.ts`. The
 * app is a Worker entrypoint with no package exports, so the alternative was
 * measuring a differently-shaped query than production runs — a copy that must
 * be kept in sync is the lesser evil, and `retrieval.test.ts` pins the shape.
 */
export function sanitizeFtsQuery(raw: string): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/["'`]/g, " ")
    .replace(/[():*^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;

  const RESERVED = new Set(["and", "or", "not", "near"]);
  const parts = cleaned.split(" ").filter((p) => {
    if (p.length === 0) return false;
    if (RESERVED.has(p.toLowerCase())) return false;
    return /[A-Za-z0-9À-￿]/.test(p);
  });
  if (parts.length === 0) return null;

  return parts.map((p) => `"${p.replace(/"/g, "")}"`).join(" OR ");
}

/** The keyword leg: FTS5 `MATCH` ordered by bm25, exactly as the app queries it. */
export function ftsRanks(
  stack: EvalStack,
  query: string,
  limit: number,
): RankedId[] {
  const clean = sanitizeFtsQuery(query);
  if (clean === null || limit <= 0) return [];
  const rows = stack.db.all<{ id: string }>(
    sql`
      SELECT e.id AS id FROM entries e
      JOIN entries_fts f ON f.rowid = e.rowid
      WHERE entries_fts MATCH ${clean}
      ORDER BY rank
      LIMIT ${limit}
    `,
  );
  return rows.map((row, index) => ({ id: row.id, rank: index + 1 }));
}

/** The semantic leg: cosine over the stored vectors. */
export async function vectorRanks(
  stack: EvalStack,
  queryVector: number[],
  limit: number,
): Promise<RankedId[]> {
  if (limit <= 0) return [];
  const matches = await stack.vectorStore.query(queryVector, { topK: limit });
  return matches.map((match, index) => ({ id: match.id, rank: index + 1 }));
}

/**
 * Runs one mode and returns the ranked entry ids, truncated to `topK` — the same
 * cut the app's `searchEntryRows` applies before hydrating rows. Every mode sees
 * the same pool size, so the comparison isolates the ranking, not the budget.
 */
export async function retrieve(
  stack: EvalStack,
  mode: RetrievalMode,
  query: string,
  queryVector: number[],
  config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
): Promise<string[]> {
  const pool = Math.max(1, Math.trunc(config.topK * config.poolMultiplier));
  if (mode === "fts") {
    return ftsRanks(stack, query, pool)
      .map((hit) => hit.id)
      .slice(0, config.topK);
  }
  if (mode === "vector") {
    const ranks = await vectorRanks(stack, queryVector, pool);
    return ranks.map((hit) => hit.id).slice(0, config.topK);
  }
  const [semantic, keyword] = await Promise.all([
    vectorRanks(stack, queryVector, pool),
    Promise.resolve(ftsRanks(stack, query, pool)),
  ]);
  return rrfMerge([semantic, keyword], config.rrfK)
    .map((hit) => hit.id)
    .slice(0, config.topK);
}
