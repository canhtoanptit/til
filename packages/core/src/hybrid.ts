import { compareIds, rrfScores } from "./retrieval.js";
import type { FusedId, RankedId } from "./retrieval.js";

/** FTS5 syntax words: operators, never content, whatever the stop list says. */
const FTS_OPERATORS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "not",
  "near",
]);

/**
 * Function words the keyword leg cannot discriminate on. FTS5 keeps no stop
 * list of its own, so without this every paraphrase question ("how do I get the
 * thing to ...") reaches the index as a dozen OR'd terms that match most of the
 * corpus, and bm25 then ranks confidently wrong rows above nothing at all.
 * `@til/evals` reads the same set, so "this query has no content word" means the
 * same thing to the dataset checks and to the retriever.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "about",
  "after",
  "again",
  "all",
  "also",
  "an",
  "and",
  "another",
  "any",
  "anything",
  "are",
  "as",
  "at",
  "back",
  "be",
  "because",
  "been",
  "before",
  "being",
  "below",
  "between",
  "both",
  "but",
  "by",
  "can",
  "cannot",
  "could",
  "did",
  "do",
  "does",
  "doing",
  "done",
  "down",
  "during",
  "each",
  "either",
  "else",
  "enough",
  "even",
  "ever",
  "every",
  "for",
  "from",
  "get",
  "gets",
  "give",
  "go",
  "goes",
  "had",
  "has",
  "have",
  "he",
  "her",
  "here",
  "him",
  "his",
  "how",
  "i",
  "if",
  "in",
  "instead",
  "into",
  "is",
  "it",
  "its",
  "just",
  "keep",
  "keeps",
  "kind",
  "know",
  "last",
  "least",
  "less",
  "let",
  "lets",
  "like",
  "made",
  "make",
  "makes",
  "many",
  "may",
  "me",
  "might",
  "more",
  "most",
  "much",
  "must",
  "my",
  "need",
  "needs",
  "never",
  "new",
  "no",
  "nobody",
  "not",
  "nothing",
  "now",
  "of",
  "off",
  "often",
  "on",
  "once",
  "one",
  "only",
  "or",
  "other",
  "others",
  "our",
  "out",
  "over",
  "own",
  "per",
  "put",
  "really",
  "same",
  "see",
  "seen",
  "several",
  "she",
  "should",
  "since",
  "so",
  "some",
  "something",
  "still",
  "such",
  "take",
  "takes",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "thing",
  "things",
  "this",
  "those",
  "though",
  "three",
  "through",
  "to",
  "too",
  "two",
  "under",
  "until",
  "up",
  "upon",
  "us",
  "use",
  "used",
  "uses",
  "using",
  "very",
  "was",
  "way",
  "ways",
  "we",
  "well",
  "were",
  "what",
  "when",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "you",
  "your",
]);

/**
 * Tokens as FTS5's default `unicode61` tokenizer would produce them: folded to
 * lower case and split on every non-alphanumeric character, so `io_uring` is two
 * tokens (`io`, `uring`) in the index and must be judged as two here too.
 */
export function ftsTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export interface SanitizeFtsQueryOptions {
  /**
   * Words that carry no keyword signal. Defaults to `STOPWORDS`; pass `null` to
   * keep every token (the pre-P17 behaviour, kept for the eval control arm).
   */
  stopwords?: ReadonlySet<string> | null;
}

/**
 * FTS5 query sanitizer: strips operators (AND/OR/NOT/NEAR/quotes/parens/colons/*)
 * and function words, then wraps each remaining term as a quoted phrase joined
 * by OR. Safe for user-provided text; the caller runs `MATCH ?` with the result.
 * `null` means the keyword leg has nothing to say and must abstain rather than
 * return whatever bm25 makes of a bag of function words.
 */
export function sanitizeFtsQuery(
  raw: string,
  opts: SanitizeFtsQueryOptions = {},
): string | null {
  if (!raw) return null;
  const stopwords = opts.stopwords === undefined ? STOPWORDS : opts.stopwords;
  const cleaned = raw
    .replace(/["'`]/g, " ")
    .replace(/[():*^~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return null;

  const parts = cleaned.split(" ").filter((part) => {
    if (part.length === 0) return false;
    if (FTS_OPERATORS.has(part.toLowerCase())) return false;
    if (!/[A-Za-z0-9À-￿]/.test(part)) return false;
    return stopwords === null || carriesMeaning(part, stopwords);
  });
  if (parts.length === 0) return null;

  return parts.map((part) => `"${part.replace(/"/g, "")}"`).join(" OR ");
}

/** How a fused score of exactly zero difference is resolved. */
export type HybridTiebreak = "id" | "semantic";

export interface HybridWeights {
  semantic: number;
  keyword: number;
}

/**
 * How much the keyword leg's vote counts.
 * - `flat`: always `weights.keyword`, whatever it matched.
 * - `selective`: full weight when the leg pinned at most
 *   `SELECTIVE_KEYWORD_HITS` documents without filling its budget, and
 *   `weights.keyword / pool` when it did not. A bag of common words matches half
 *   the library and is a topic guess; a rare identifier matches one row and is
 *   evidence.
 */
export type KeywordVote = "flat" | "selective";

/** Above this many hits the keyword leg has located a topic, not a document. */
export const SELECTIVE_KEYWORD_HITS = 3;

export interface FuseHybridOptions {
  k?: number;
  weights?: HybridWeights;
  tiebreak?: HybridTiebreak;
  keywordVote?: KeywordVote;
  /**
   * Candidate budget each leg was offered. A keyword leg that filled it was
   * truncated, so its length says nothing about how selective the query was.
   * Defaults to the keyword leg's own length.
   */
  pool?: number;
}

/**
 * The shipped fusion policy, measured by `@til/evals`' retrieval suite (P17.1).
 *
 * Two things were wrong before. With equal weights, rank 1 of either leg scores
 * exactly `1/(k+1)`, so a keyword hit and a semantic hit were indistinguishable
 * and the merge degenerated into interleaving broken by entry id — which measured
 * *worse overall than the semantic leg alone*, because the keyword leg answered
 * paraphrase questions it had no business answering. And it answered them at all
 * because nothing made it abstain.
 *
 * So: semantic outweighs keyword, and the keyword vote is scaled by how selective
 * the match was. At these numbers a diffuse keyword leg's vote is provably too
 * small to displace the semantic leg's top hit (`w_k/pool < w_s/(k+2)` holds for
 * every pool above ten), while a leg that pinned a couple of rows votes at full
 * strength and can promote them — the one thing the keyword leg uniquely buys.
 *
 * `k` is 20 rather than `RRF_K`: a smaller k widens the gaps between the semantic
 * leg's own ranks, which is what keeps a cross-leg vote from leapfrogging several
 * positions at once. Measured 0.828 overall nDCG@8 against vector-only's 0.806,
 * on a plateau covering pool 2x-4x.
 */
export const HYBRID_DEFAULTS: {
  readonly k: number;
  readonly weights: HybridWeights;
  readonly tiebreak: HybridTiebreak;
  readonly keywordVote: KeywordVote;
  /** Candidates each leg fetches, as a multiple of the caller's topK. */
  readonly poolMultiplier: number;
} = {
  k: 20,
  weights: { semantic: 0.7, keyword: 0.3 },
  tiebreak: "semantic",
  keywordVote: "selective",
  poolMultiplier: 2,
};

/**
 * Weighted reciprocal rank fusion of the semantic and keyword legs: an entry
 * scores `weight / (k + rank)` per leg it appears in, summed, where the keyword
 * leg's weight also depends on how selective its match was (see `KeywordVote`).
 * Ranks are 1-based and an empty leg contributes nothing, so an abstaining keyword
 * leg leaves the semantic order untouched.
 */
export function fuseHybrid(
  semantic: readonly RankedId[],
  keyword: readonly RankedId[],
  opts: FuseHybridOptions = {},
): FusedId[] {
  const weights = opts.weights ?? HYBRID_DEFAULTS.weights;
  const tiebreak = opts.tiebreak ?? HYBRID_DEFAULTS.tiebreak;
  const scores = rrfScores(
    [
      { items: semantic, weight: weights.semantic },
      { items: keyword, weight: keywordWeight(keyword, weights, opts) },
    ],
    opts.k ?? HYBRID_DEFAULTS.k,
  );

  const semanticRank = new Map<string, number>();
  for (const hit of semantic) {
    if (!semanticRank.has(hit.id)) semanticRank.set(hit.id, hit.rank);
  }

  const fused: FusedId[] = [];
  for (const [id, score] of scores) fused.push({ id, score });
  fused.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    if (tiebreak === "semantic") {
      const left = semanticRank.get(a.id) ?? Number.POSITIVE_INFINITY;
      const right = semanticRank.get(b.id) ?? Number.POSITIVE_INFINITY;
      if (left !== right) return left < right ? -1 : 1;
    }
    return compareIds(a.id, b.id);
  });
  return fused;
}

function keywordWeight(
  keyword: readonly RankedId[],
  weights: HybridWeights,
  opts: FuseHybridOptions,
): number {
  const vote = opts.keywordVote ?? HYBRID_DEFAULTS.keywordVote;
  if (vote === "flat" || keyword.length === 0) return weights.keyword;
  const budget =
    opts.pool !== undefined && Number.isFinite(opts.pool) && opts.pool > 0
      ? opts.pool
      : keyword.length;
  const selective =
    keyword.length <= SELECTIVE_KEYWORD_HITS && keyword.length < budget;
  return selective ? weights.keyword : weights.keyword / budget;
}

/**
 * WHY per token and not per part: `io_uring`, `--max-old-space-size` and
 * `bge-m3` are single query parts whose tokens are what the index actually
 * holds, and none of those tokens is a function word. A part whose tokens are
 * *all* function words carries no keyword signal and goes. A part with no ASCII
 * token at all (accents, CJK) is kept — an English stop list cannot speak for it.
 */
function carriesMeaning(part: string, stopwords: ReadonlySet<string>): boolean {
  const tokens = ftsTokens(part);
  if (tokens.length === 0) return true;
  return tokens.some((token) => !stopwords.has(token));
}
