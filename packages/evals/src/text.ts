/**
 * Tokenisation used by the dataset integrity checks, deliberately matching
 * FTS5's default `unicode61` tokenizer: fold to lower case and split on every
 * non-alphanumeric character (so `io_uring` becomes `io` and `uring`, exactly
 * as the index stores it).
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Function words a keyword leg cannot discriminate on: FTS5 has no stop list, so
 * these do match, but bm25's inverse document frequency term makes a word that
 * occurs in most rows worth almost nothing. Excluding them from the overlap
 * check is what makes "this semantic query shares no keywords with its target"
 * a claim about content words rather than about English grammar.
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

/** Folds a trivial plural so `readers` and `reader` count as the same word. */
export function fold(token: string): string {
  if (token.length > 3 && token.endsWith("ies"))
    return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) {
    return token.slice(0, -1);
  }
  return token;
}

/** Content words of a text: tokenized, stop-word filtered, plural-folded. */
export function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of tokenize(text)) {
    if (STOPWORDS.has(token)) continue;
    out.add(fold(token));
  }
  return out;
}

/** Content words the two texts share — empty means no keyword overlap. */
export function sharedContentWords(a: string, b: string): string[] {
  const left = contentWords(a);
  const right = contentWords(b);
  const shared: string[] = [];
  for (const word of left) {
    if (right.has(word)) shared.push(word);
  }
  return shared.sort();
}
