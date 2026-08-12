import { cosineSimilarity } from "@til/core";
import { entries } from "@til/db";
import { desc, eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import {
  blendRankedItems,
  interestTextFor,
  MAX_INTEREST_VECTORS,
  type RankedItem,
} from "./digest.js";

/**
 * How many stored vectors are read at a time. `VectorStore` only exposes
 * `getVector(id)`, so a 200-entry profile is 200 reads; against Vectorize those
 * are subrequests, and firing all of them at once is how a Worker trips its
 * concurrent-subrequest limits. Eight keeps the wall clock near-parallel without
 * that risk.
 */
export const INTEREST_VECTOR_READ_CONCURRENCY = 8;

export interface Personalization {
  /** `ranked` with `interestScore`/`blendedScore` attached, re-ordered by blend. */
  items: RankedItem[];
  /** How many stored vectors the profile was built from; for the run log. */
  profileSize: number;
}

/**
 * The interest half of C18. Returns null — never throws for it — when
 * personalization does not apply at all: no embedder, no vector store, nothing to
 * rank, or an empty interest profile. A null result means the caller must keep the
 * base ranking and persist null interest scores, which is exactly today's behavior.
 *
 * It *does* throw when the embedder or the vector store fails, on purpose: that is
 * a transient fault the Workflow step should get its retries at, and `runDigest`
 * degrades the run if those run out. Failing quietly here would spend the retry
 * budget on nothing.
 */
export async function personalizeRanked(
  deps: Deps,
  ranked: readonly RankedItem[],
  opts: { limit?: number } = {},
): Promise<Personalization | null> {
  const { embedder, vectorStore } = deps;
  if (!embedder || !vectorStore) return null;
  if (ranked.length === 0) return null;

  const profile = await loadInterestProfile(deps, opts.limit);
  // No saved reading to compare against: skip the embed call rather than bill for
  // a comparison whose answer is already known to be "no signal".
  if (profile.length === 0) return null;

  const vectors = await embedder.embed(ranked.map(interestTextFor));
  const interests: number[] = [];
  for (let i = 0; i < ranked.length; i += 1) {
    const vector = vectors[i];
    // All-or-nothing: a short batch is a broken embedder, and half a personalized
    // pool would mix two incomparable score scales in one ordering.
    if (!vector) {
      throw new Error(
        `embedder returned ${vectors.length} vector(s) for ${ranked.length} item(s)`,
      );
    }
    interests.push(maxSimilarity(vector, profile));
  }

  return {
    items: blendRankedItems(ranked, interests),
    profileSize: profile.length,
  };
}

/**
 * The owner's most recently saved entries' vectors, newest first, capped at
 * `MAX_INTEREST_VECTORS`.
 *
 * Recency is `entries.created_at`, not the vector's own timestamp: the entries
 * table is the same in both stacks, whereas `entry_vectors` only exists for the
 * local store, so this is the one definition of "your recent reading" that means
 * the same thing on Vectorize and on D1. The cap applies to the entry scan, so an
 * entry that was never indexed simply contributes nothing.
 */
export async function loadInterestProfile(
  deps: Deps,
  limit = MAX_INTEREST_VECTORS,
): Promise<number[][]> {
  const { vectorStore } = deps;
  if (!vectorStore) return [];
  const capped = Math.min(MAX_INTEREST_VECTORS, Math.max(0, Math.trunc(limit)));
  if (capped === 0) return [];

  const rows = await deps.db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.status, "ready"))
    // `id` breaks ties so a profile is the same set on every replay of a run.
    .orderBy(desc(entries.createdAt), desc(entries.id))
    .limit(capped);

  const out: number[][] = [];
  for (let i = 0; i < rows.length; i += INTEREST_VECTOR_READ_CONCURRENCY) {
    const chunk = rows.slice(i, i + INTEREST_VECTOR_READ_CONCURRENCY);
    const values = await Promise.all(
      chunk.map((row) => vectorStore.getVector(row.id)),
    );
    for (const vector of values) {
      if (vector !== null && vector.length > 0) out.push(vector);
    }
  }
  return out;
}

/**
 * Max cosine similarity against the profile. Off-dimension profile vectors are
 * skipped rather than thrown on: a corpus embedded with an older model outliving a
 * model switch is a re-embed away from fine, and must not take the digest with it.
 */
function maxSimilarity(vector: number[], profile: readonly number[][]): number {
  let best = 0;
  let mismatched = 0;
  let compared = 0;
  for (const stored of profile) {
    if (stored.length !== vector.length) {
      mismatched += 1;
      continue;
    }
    const score = cosineSimilarity(vector, stored);
    if (compared === 0 || score > best) best = score;
    compared += 1;
  }
  if (compared === 0 && mismatched > 0) {
    console.warn(
      `[digest] all ${mismatched} interest vector(s) differ in dimension from the ${vector.length}-d digest embedding — re-embed to personalize.`,
    );
  }
  return compared === 0 ? 0 : best;
}
