export const RRF_K = 60;

export interface RankedId {
  id: string;
  rank: number;
}

export interface FusedId {
  id: string;
  score: number;
}

export function embeddingTextFor(e: {
  title?: string | null;
  takeaway?: string | null;
  summary?: string | null;
  tags?: string[] | null;
}): string {
  const parts: string[] = [];
  for (const field of [e.title, e.takeaway, e.summary]) {
    const text = clean(field);
    if (text !== undefined) parts.push(text);
  }
  const tags: string[] = [];
  for (const tag of e.tags ?? []) {
    const text = clean(tag);
    if (text !== undefined) tags.push(text);
  }
  if (tags.length > 0) parts.push(`Tags: ${tags.join(", ")}`);
  return parts.join("\n");
}

// Reciprocal rank fusion: an id's score is the sum of 1/(k + rank) over every
// list it appears in, so agreement between the semantic and keyword lists beats
// a single list's top hit. Ranks are 1-based.
export function rrfMerge(
  lists: { id: string; rank: number }[][],
  k: number = RRF_K,
): { id: string; score: number }[] {
  const safeK = Number.isFinite(k) ? k : RRF_K;
  const scores = new Map<string, number>();
  for (const list of lists) {
    for (const entry of list) {
      if (!Number.isFinite(entry.rank)) continue;
      const denominator = safeK + entry.rank;
      // WHY: a non-positive denominator would emit ±Infinity/NaN and make the
      // sort order (and every downstream score) meaningless.
      if (denominator <= 0) continue;
      scores.set(entry.id, (scores.get(entry.id) ?? 0) + 1 / denominator);
    }
  }
  const fused: FusedId[] = [];
  for (const [id, score] of scores) fused.push({ id, score });
  fused.sort((a, b) => b.score - a.score || compareText(a.id, b.id));
  return fused;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `cosineSimilarity: vector lengths differ (${a.length} vs ${b.length}).`,
    );
  }
  let dot = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    sumA += x * x;
    sumB += y * y;
  }
  if (sumA === 0 || sumB === 0) return 0;
  const magnitude = Math.sqrt(sumA * sumB);
  if (!Number.isFinite(magnitude) || magnitude === 0) return 0;
  const score = dot / magnitude;
  return Number.isFinite(score) ? score : 0;
}

export function normalizeVector(v: number[]): number[] {
  let sumSquares = 0;
  for (const value of v) sumSquares += value * value;
  if (sumSquares === 0 || !Number.isFinite(sumSquares)) return v;
  const magnitude = Math.sqrt(sumSquares);
  if (!Number.isFinite(magnitude) || magnitude === 0) return v;
  return v.map((value) => value / magnitude);
}

function clean(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
