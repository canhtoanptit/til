/**
 * Classic information-retrieval metrics over a ranked list of entry ids.
 *
 * Shared conventions:
 * - Relevance is **binary**: an id is either in the gold `expected` set or not.
 *   The golden sets carry no graded judgements, so graded gains would be fiction.
 * - Ranks are **1-based**, matching `rrfMerge`.
 * - A repeated id counts once, at its first position: a ranker that pads its
 *   list with duplicates must not be able to inflate recall.
 * - An **empty `expected`** set scores 0 rather than 1 or NaN. Such a case is a
 *   dataset bug, and 0 drags the mean down where it is visible, instead of
 *   silently inflating it or poisoning every aggregate with NaN.
 * - `k` below 1, or not finite, scores 0. `k` beyond the list length simply uses
 *   the whole list.
 */

/** Fraction of the gold entries that appear in the top `k`. */
export function recallAtK(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): number {
  const gold = new Set(expected);
  if (gold.size === 0) return 0;
  const top = topK(ranked, k);
  let found = 0;
  for (const id of top) {
    if (gold.has(id)) found += 1;
  }
  return found / gold.size;
}

/**
 * Reciprocal rank of the first gold entry, 0 when none is retrieved. Averaged
 * over the query set by the caller, this is MRR; per query it is RR.
 */
export function mrr(
  ranked: readonly string[],
  expected: readonly string[],
): number {
  const gold = new Set(expected);
  if (gold.size === 0) return 0;
  const list = dedupe(ranked);
  for (let i = 0; i < list.length; i += 1) {
    const id = list[i];
    if (id !== undefined && gold.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/**
 * Normalised discounted cumulative gain at `k`, in the standard formulation:
 * binary gains, `1 / log2(rank + 1)` discount, and an ideal ranking that puts
 * `min(|expected|, k)` gold entries in the top positions. So a single-gold case
 * scores 1 when the entry is first, `1 / log2(3)` ≈ 0.63 when it is second, and
 * a two-gold case scores 1 only when both lead the list.
 */
export function ndcgAtK(
  ranked: readonly string[],
  expected: readonly string[],
  k: number,
): number {
  const gold = new Set(expected);
  if (gold.size === 0) return 0;
  const top = topK(ranked, k);
  if (top.length === 0) return 0;

  let dcg = 0;
  for (let i = 0; i < top.length; i += 1) {
    const id = top[i];
    if (id !== undefined && gold.has(id)) dcg += discount(i + 1);
  }
  if (dcg === 0) return 0;

  let ideal = 0;
  const reachable = Math.min(gold.size, top.length);
  for (let i = 0; i < reachable; i += 1) ideal += discount(i + 1);
  return ideal === 0 ? 0 : dcg / ideal;
}

/** Arithmetic mean; an empty sample is 0, so an empty slice prints as 0.000. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * Fraction of `claimed` that appears in `allowed` — used for citation precision,
 * where `claimed` are the urls in an answer and `allowed` are the urls the tools
 * actually returned. An answer that cites nothing is perfectly precise (1), so
 * callers that care about the difference must check the count separately.
 */
export function precision(
  claimed: readonly string[],
  allowed: readonly string[],
): number {
  const list = dedupe(claimed);
  if (list.length === 0) return 1;
  const permitted = new Set(allowed);
  let ok = 0;
  for (const item of list) {
    if (permitted.has(item)) ok += 1;
  }
  return ok / list.length;
}

function discount(rank: number): number {
  return 1 / Math.log2(rank + 1);
}

function topK(ranked: readonly string[], k: number): string[] {
  if (!Number.isFinite(k) || k < 1) return [];
  return dedupe(ranked).slice(0, Math.trunc(k));
}

function dedupe(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
