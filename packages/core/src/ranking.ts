import type { Candidate, EvidenceCluster, ScoredCluster } from "./types.js";
import { normalizeUrl } from "./url.js";

const DAY_MS = 86_400_000;

const TITLE_SIMILARITY_THRESHOLD = 0.8;

// Below three content tokens a title carries too little signal to justify merging
// two different URLs (e.g. two unrelated posts both titled "Weekly links").
const MIN_TOKENS_FOR_TITLE_MERGE = 3;

const WEIGHT_RECENCY = 0.4;
const WEIGHT_POPULARITY = 0.4;
const WEIGHT_CORROBORATION = 0.2;

// Sources without a vote count (arXiv, RSS) are treated as average rather than
// worst, otherwise the ranking would be a pure Hacker News mirror.
const NEUTRAL_POPULARITY = 0.5;

const CORROBORATION_SATURATION = 3;

const SCORE_PRECISION = 1e6;

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "with",
  // Aggregator decorations, not content.
  "ask",
  "hn",
  "show",
  "tell",
]);

export function titleTokens(title: string): Set<string> {
  const words = title
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .split(" ");
  const tokens = new Set<string>();
  for (const word of words) {
    if (word.length === 0) continue;
    if (STOPWORDS.has(word)) continue;
    if (word.length < 2 && !/^\d$/.test(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

export function titleSimilarity(a: string, b: string): number {
  return jaccard(titleTokens(a), titleTokens(b));
}

export function clusterCandidates(candidates: Candidate[]): EvidenceCluster[] {
  const groups = groupByCanonicalUrl(candidates);
  if (groups.length === 0) return [];

  const parent = groups.map((_, index) => index);
  for (let i = 0; i < groups.length; i += 1) {
    for (let j = i + 1; j < groups.length; j += 1) {
      if (shouldMergeByTitle(groups[i], groups[j])) union(parent, i, j);
    }
  }

  const merged = new Map<number, Candidate[]>();
  groups.forEach((group, index) => {
    const root = find(parent, index);
    const bucket = merged.get(root);
    if (bucket === undefined) merged.set(root, [...group.candidates]);
    else bucket.push(...group.candidates);
  });

  const clusters: EvidenceCluster[] = [];
  for (const members of merged.values()) {
    const cluster = toCluster(members);
    if (cluster !== undefined) clusters.push(cluster);
  }

  clusters.sort(
    (a, b) =>
      b.publishedAt - a.publishedAt || compareText(a.canonicalUrl, b.canonicalUrl),
  );
  return clusters;
}

export function scoreClusters(
  clusters: EvidenceCluster[],
  opts: { now: number; windowDays: number },
): ScoredCluster[] {
  const maxBySource = maxPopularityBySource(clusters);
  const windowMs = Math.max(1, opts.windowDays) * DAY_MS;

  const scored = clusters.map((cluster): ScoredCluster => {
    const recency = clamp01(
      1 - Math.max(0, opts.now - cluster.publishedAt) / windowMs,
    );
    const popularity = clusterPopularity(cluster, maxBySource);
    const corroboration = clamp01(
      (cluster.sources.length - 1) / (CORROBORATION_SATURATION - 1),
    );
    const raw =
      WEIGHT_RECENCY * recency +
      WEIGHT_POPULARITY * popularity +
      WEIGHT_CORROBORATION * corroboration;
    return {
      ...cluster,
      score: Math.round(raw * SCORE_PRECISION) / SCORE_PRECISION,
    };
  });

  scored.sort(
    (a, b) =>
      b.score - a.score || compareText(a.canonicalUrl, b.canonicalUrl),
  );
  return scored;
}

interface UrlGroup {
  canonicalUrl: string;
  candidates: Candidate[];
  tokens: Set<string>;
}

function groupByCanonicalUrl(candidates: Candidate[]): UrlGroup[] {
  const byUrl = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (candidate.title.trim().length === 0) continue;
    let canonicalUrl: string;
    try {
      canonicalUrl = normalizeUrl(candidate.url).canonicalUrl;
    } catch {
      continue;
    }
    const bucket = byUrl.get(canonicalUrl);
    if (bucket === undefined) byUrl.set(canonicalUrl, [candidate]);
    else bucket.push(candidate);
  }

  const groups: UrlGroup[] = [];
  for (const [canonicalUrl, members] of byUrl) {
    const best = pickBest(members);
    if (best === undefined) continue;
    groups.push({
      canonicalUrl,
      candidates: members,
      tokens: titleTokens(best.title),
    });
  }
  groups.sort((a, b) => compareText(a.canonicalUrl, b.canonicalUrl));
  return groups;
}

function shouldMergeByTitle(
  a: UrlGroup | undefined,
  b: UrlGroup | undefined,
): boolean {
  if (a === undefined || b === undefined) return false;
  if (
    a.tokens.size < MIN_TOKENS_FOR_TITLE_MERGE ||
    b.tokens.size < MIN_TOKENS_FOR_TITLE_MERGE
  ) {
    return false;
  }
  return jaccard(a.tokens, b.tokens) >= TITLE_SIMILARITY_THRESHOLD;
}

function toCluster(members: Candidate[]): EvidenceCluster | undefined {
  const best = pickBest(members);
  if (best === undefined) return undefined;

  let canonicalUrl: string;
  try {
    canonicalUrl = normalizeUrl(best.url).canonicalUrl;
  } catch {
    return undefined;
  }

  const candidates = [...members].sort(compareCandidateOrder);
  const sources = [...new Set(candidates.map((c) => c.sourceName))].sort(
    compareText,
  );
  let publishedAt = candidates[0]?.publishedAt ?? 0;
  for (const candidate of candidates) {
    if (candidate.publishedAt < publishedAt) publishedAt = candidate.publishedAt;
  }

  return {
    canonicalUrl,
    title: best.title,
    candidates,
    sources,
    publishedAt,
  };
}

function pickBest(candidates: readonly Candidate[]): Candidate | undefined {
  let best: Candidate | undefined;
  for (const candidate of candidates) {
    if (best === undefined || compareCandidateQuality(candidate, best) < 0) {
      best = candidate;
    }
  }
  return best;
}

function compareCandidateQuality(a: Candidate, b: Candidate): number {
  const truncated = Number(isTruncated(a.title)) - Number(isTruncated(b.title));
  if (truncated !== 0) return truncated;
  const length = b.title.trim().length - a.title.trim().length;
  if (length !== 0) return length;
  const popularity = (b.popularity ?? -1) - (a.popularity ?? -1);
  if (popularity !== 0) return popularity;
  return compareCandidateOrder(a, b);
}

function compareCandidateOrder(a: Candidate, b: Candidate): number {
  return (
    compareText(a.sourceName, b.sourceName) ||
    a.publishedAt - b.publishedAt ||
    compareText(a.url, b.url)
  );
}

function isTruncated(title: string): boolean {
  return /(?:…|\.\.\.)$/.test(title.trim());
}

function maxPopularityBySource(
  clusters: readonly EvidenceCluster[],
): Map<string, number> {
  const maxBySource = new Map<string, number>();
  for (const cluster of clusters) {
    for (const candidate of cluster.candidates) {
      const popularity = finitePopularity(candidate);
      if (popularity === undefined) continue;
      const current = maxBySource.get(candidate.sourceName) ?? 0;
      if (popularity > current) {
        maxBySource.set(candidate.sourceName, popularity);
      }
    }
  }
  return maxBySource;
}

// log1p keeps a 50-point story from rounding to zero next to a 2000-point outlier,
// and dividing by the per-source maximum makes HN points and Lobsters scores
// comparable on a 0..1 scale.
function clusterPopularity(
  cluster: EvidenceCluster,
  maxBySource: Map<string, number>,
): number {
  let best: number | undefined;
  for (const candidate of cluster.candidates) {
    const popularity = finitePopularity(candidate);
    if (popularity === undefined) continue;
    const max = maxBySource.get(candidate.sourceName) ?? 0;
    const normalized = max <= 0 ? 0 : Math.log1p(popularity) / Math.log1p(max);
    const clamped = clamp01(normalized);
    best = best === undefined ? clamped : Math.max(best, clamped);
  }
  return best ?? NEUTRAL_POPULARITY;
}

function finitePopularity(candidate: Candidate): number | undefined {
  const { popularity } = candidate;
  if (typeof popularity !== "number" || !Number.isFinite(popularity)) {
    return undefined;
  }
  return Math.max(0, popularity);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }
  if (intersection === 0) return 0;
  return intersection / (a.size + b.size - intersection);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function find(parent: number[], index: number): number {
  let root = index;
  let next = parent[root];
  while (next !== undefined && next !== root) {
    root = next;
    next = parent[root];
  }
  let cursor = index;
  let step = parent[cursor];
  while (step !== undefined && step !== cursor) {
    parent[cursor] = root;
    cursor = step;
    step = parent[cursor];
  }
  return root;
}

function union(parent: number[], a: number, b: number): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA === rootB) return;
  const [low, high] = rootA < rootB ? [rootA, rootB] : [rootB, rootA];
  parent[high] = low;
}
