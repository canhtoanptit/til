import { ftsTokens, STOPWORDS } from "@til/core";

/**
 * Tokenisation and the function-word list both live in `@til/core` now: the
 * retriever's keyword leg filters on exactly this set, so "this semantic query
 * shares no content word with its target" is a claim about the same words the
 * system itself ignores. Re-exported because the dataset checks read them by
 * these names.
 */
export { ftsTokens as tokenize, STOPWORDS };

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
  for (const token of ftsTokens(text)) {
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
