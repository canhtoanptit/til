import { sql } from "drizzle-orm";
import { OWNER_USER_ID } from "@til/db";
import { fuseHybrid, HYBRID_DEFAULTS, sanitizeFtsQuery } from "@til/core";
import type {
  HybridTiebreak,
  HybridWeights,
  KeywordVote,
  RankedId,
} from "@til/core";
import type { EvalStack } from "./runner.js";

export type RetrievalMode = "fts" | "vector" | "hybrid";

export const RETRIEVAL_MODES: readonly RetrievalMode[] = [
  "fts",
  "vector",
  "hybrid",
];

/**
 * One candidate fusion policy. `abstain` is about the keyword leg's *query*
 * (stop-word filtering, so a question made of function words produces no
 * candidates instead of confident junk); the rest are about the merge.
 */
export interface FusionPolicy {
  id: string;
  abstain: boolean;
  weights: HybridWeights;
  tiebreak: HybridTiebreak;
  keywordVote: KeywordVote;
}

const EVEN: HybridWeights = { semantic: 1, keyword: 1 };

/** Pre-P17.1 production: no abstention, equal weights, ties broken by entry id. */
export const CONTROL_POLICY: FusionPolicy = {
  id: "control",
  abstain: false,
  weights: EVEN,
  tiebreak: "id",
  keywordVote: "flat",
};

/** Whatever `@til/core` currently ships, so the suite measures production. */
export const SHIPPED_POLICY: FusionPolicy = {
  id: "shipped",
  abstain: true,
  weights: HYBRID_DEFAULTS.weights,
  tiebreak: HYBRID_DEFAULTS.tiebreak,
  keywordVote: HYBRID_DEFAULTS.keywordVote,
};

/**
 * The arms of the P17.1 ablation. The three mechanisms — abstention, weighting and
 * the selective keyword vote — are varied independently, and two arms drop
 * abstention while keeping the rest, so a win cannot be credited to the wrong one.
 */
export const FUSION_POLICIES: readonly FusionPolicy[] = [
  CONTROL_POLICY,
  {
    id: "abstain",
    abstain: true,
    weights: EVEN,
    tiebreak: "id",
    keywordVote: "flat",
  },
  {
    id: "abstain+semfirst",
    abstain: true,
    weights: EVEN,
    tiebreak: "semantic",
    keywordVote: "flat",
  },
  {
    id: "abstain+w60/40",
    abstain: true,
    weights: { semantic: 0.6, keyword: 0.4 },
    tiebreak: "semantic",
    keywordVote: "flat",
  },
  {
    id: "abstain+w70/30",
    abstain: true,
    weights: { semantic: 0.7, keyword: 0.3 },
    tiebreak: "semantic",
    keywordVote: "flat",
  },
  {
    id: "abstain+w80/20",
    abstain: true,
    weights: { semantic: 0.8, keyword: 0.2 },
    tiebreak: "semantic",
    keywordVote: "flat",
  },
  {
    id: "w70/30 only",
    abstain: false,
    weights: { semantic: 0.7, keyword: 0.3 },
    tiebreak: "semantic",
    keywordVote: "flat",
  },
  {
    id: "abstain+w70/30+selective",
    abstain: true,
    weights: { semantic: 0.7, keyword: 0.3 },
    tiebreak: "semantic",
    keywordVote: "selective",
  },
  {
    id: "abstain+w60/40+selective",
    abstain: true,
    weights: { semantic: 0.6, keyword: 0.4 },
    tiebreak: "semantic",
    keywordVote: "selective",
  },
  {
    id: "abstain+w80/20+selective",
    abstain: true,
    weights: { semantic: 0.8, keyword: 0.2 },
    tiebreak: "semantic",
    keywordVote: "selective",
  },
  {
    id: "w70/30+selective only",
    abstain: false,
    weights: { semantic: 0.7, keyword: 0.3 },
    tiebreak: "semantic",
    keywordVote: "selective",
  },
];

export interface RetrievalConfig {
  topK: number;
  /** Candidates each leg fetches, as a multiple of topK. */
  poolMultiplier: number;
  rrfK: number;
  policy: FusionPolicy;
}

/** The production defaults this suite exists to question, read from core. */
export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  topK: 8,
  poolMultiplier: HYBRID_DEFAULTS.poolMultiplier,
  rrfK: HYBRID_DEFAULTS.k,
  policy: SHIPPED_POLICY,
};

/** The keyword leg: FTS5 `MATCH` ordered by bm25, exactly as the app queries it. */
export function ftsRanks(
  stack: EvalStack,
  query: string,
  limit: number,
  opts: { abstain?: boolean } = {},
): RankedId[] {
  const clean = sanitizeFtsQuery(
    query,
    opts.abstain === false ? { stopwords: null } : {},
  );
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
  const matches = await stack.vectorStore.query(queryVector, {
    topK: limit,
    userId: OWNER_USER_ID,
  });
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
  const { policy } = config;
  if (mode === "fts") {
    return ftsRanks(stack, query, pool, { abstain: policy.abstain })
      .map((hit) => hit.id)
      .slice(0, config.topK);
  }
  if (mode === "vector") {
    const ranks = await vectorRanks(stack, queryVector, pool);
    return ranks.map((hit) => hit.id).slice(0, config.topK);
  }
  const [semantic, keyword] = await Promise.all([
    vectorRanks(stack, queryVector, pool),
    Promise.resolve(ftsRanks(stack, query, pool, { abstain: policy.abstain })),
  ]);
  return fuseHybrid(semantic, keyword, {
    k: config.rrfK,
    weights: policy.weights,
    tiebreak: policy.tiebreak,
    keywordVote: policy.keywordVote,
    pool,
  })
    .map((hit) => hit.id)
    .slice(0, config.topK);
}
