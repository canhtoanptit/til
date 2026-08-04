import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import type TurndownService from "turndown";
// WHY the deep browser path: turndown's default entry eagerly `require`s
// @mixmark-io/domino at module load, pulling ~400 kB of Node-only DOM into the
// Worker bundle for a code path we never take (we hand turndown a DOM node, not
// a string). The browser build drops domino and degrades safely in an isolate
// that has no DOMParser. No types are published for the subpath.
// @ts-expect-error -- untyped subpath; the shape is TurndownService
import TurndownImpl from "turndown/lib/turndown.browser.es.js";
import type { Extractor } from "@til/core";
import { ExtractionError } from "@til/core";

interface MarkdownDocumentInput {
  name: string;
  blob: Blob;
}

interface ConversionResult {
  id?: string;
  name?: string;
  format?: "markdown" | "text" | "error";
  mimetype?: string;
  tokens?: number;
  data?: string;
  error?: string;
}

interface WorkersAIToMarkdown {
  toMarkdown(
    input: MarkdownDocumentInput | MarkdownDocumentInput[],
  ): Promise<ConversionResult | ConversionResult[]>;
}

function firstResult(
  raw: ConversionResult | ConversionResult[],
): ConversionResult {
  if (Array.isArray(raw)) {
    const first = raw[0];
    if (!first) throw new ExtractionError("Empty toMarkdown response.");
    return first;
  }
  return raw;
}

function extractTitleFromHtml(html: string): string | undefined {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match || !match[1]) return undefined;
  const decoded = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  return decoded.length > 0 ? decoded : undefined;
}

export class WorkersAIExtractor implements Extractor {
  private readonly ai: WorkersAIToMarkdown;

  constructor(ai: WorkersAIToMarkdown) {
    this.ai = ai;
  }

  async toMarkdown(
    html: string,
    url: string,
  ): Promise<{ markdown: string; title?: string }> {
    const name = filenameFromUrl(url);
    const blob = new Blob([html], { type: "text/html" });
    let raw: ConversionResult | ConversionResult[];
    try {
      raw = await this.ai.toMarkdown({ name, blob });
    } catch (err) {
      throw new ExtractionError(
        `env.AI.toMarkdown failed: ${describeError(err)}`,
      );
    }
    const result = firstResult(raw);
    if (result.format === "error" || typeof result.data !== "string") {
      throw new ExtractionError(
        result.error ?? "toMarkdown returned no data.",
      );
    }
    const markdown = result.data.trim();
    if (markdown.length === 0) {
      throw new ExtractionError("Extracted markdown was empty.");
    }
    return { markdown, title: extractTitleFromHtml(html) };
  }
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (_, ref: string) => {
    if (ref.startsWith("#x") || ref.startsWith("#X")) {
      const code = parseInt(ref.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    if (ref.startsWith("#")) {
      const code = parseInt(ref.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : "";
    }
    return ENTITY_MAP[ref.toLowerCase()] ?? "";
  });
}

// WHY a floor at all: Readability will happily return a heading plus one stray
// line for a 404 or a link-list page. Digesting that wastes an LLM call and
// stores a meaningless summary, so it is better to fail and let the owner
// reingest. Deliberately well below Readability's own 500-char threshold so
// genuinely terse posts still make it through.
const MIN_ARTICLE_CHARS = 140;

// The worker tsconfig has no `lib.dom`, so the parsed document is typed off
// linkedom rather than the global `Document`.
type ParsedDocument = ReturnType<typeof parseHTML>["document"];
type ArticleNode = { cloneNode(deep: boolean): unknown };

const Turndown = TurndownImpl as typeof TurndownService;

function newTurndown(): TurndownService {
  const turndown = new Turndown({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    hr: "---",
    emDelimiter: "_",
    linkStyle: "inlined",
  });
  turndown.remove(["script", "style", "noscript"]);
  // WHY: Readability keeps <img>, and a single inline data: URI can add tens of
  // kilobytes of base64 to the markdown the digest prompt then pays for. Alt
  // text is the only part with meaning for a summary.
  turndown.addRule("imageAltOnly", {
    filter: ["img", "picture", "svg"],
    replacement: (_content, node) => {
      const alt = (node as { getAttribute?: (n: string) => string | null })
        .getAttribute?.("alt")
        ?.trim();
      return alt !== undefined && alt.length > 0 ? alt : "";
    },
  });
  return turndown;
}

/**
 * Reader-view extraction entirely inside the isolate: linkedom parses the HTML,
 * Readability picks the article subtree, Turndown renders it as markdown. Used
 * in `TIL_STACK=local`, where `env.AI.toMarkdown` is unavailable.
 */
export class ReadabilityExtractor implements Extractor {
  async toMarkdown(
    html: string,
    url: string,
  ): Promise<{ markdown: string; title?: string }> {
    if (html.trim().length === 0) {
      throw new ExtractionError("Cannot extract an article from empty HTML.");
    }

    let document: ParsedDocument;
    try {
      document = parseHTML(html).document;
    } catch (err) {
      throw new ExtractionError(`Could not parse HTML: ${describeError(err)}`);
    }
    if (!document.documentElement) {
      throw new ExtractionError("Parsed HTML had no document element.");
    }
    applyBaseHref(document, url);

    let article: { title?: string | null; content?: ArticleNode | null } | null;
    try {
      // `serializer` hands back the article Element rather than an HTML string,
      // so Turndown can walk it directly — Workers have no DOMParser, which is
      // what Turndown reaches for when given a string.
      article = new Readability<ArticleNode>(document, {
        serializer: (node) => node as unknown as ArticleNode,
      }).parse();
    } catch (err) {
      throw new ExtractionError(
        `Readability failed on ${url}: ${describeError(err)}`,
      );
    }

    const content = article?.content;
    if (!article || !content) {
      throw new ExtractionError(`Readability found no article at ${url}.`);
    }

    let markdown: string;
    try {
      markdown = newTurndown().turndown(content as never).trim();
    } catch (err) {
      throw new ExtractionError(
        `Markdown conversion failed for ${url}: ${describeError(err)}`,
      );
    }
    markdown = markdown.replace(/\n{3,}/g, "\n\n");

    if (markdown.length < MIN_ARTICLE_CHARS) {
      throw new ExtractionError(
        `Extracted article was too short (${markdown.length} chars) to summarise.`,
      );
    }

    const title = firstNonEmpty(article.title, documentTitle(document));
    return title === undefined ? { markdown } : { markdown, title };
  }
}

function applyBaseHref(document: ParsedDocument, url: string): void {
  // WHY: linkedom leaves baseURI null, so Readability cannot absolutise the
  // article's relative links unless the document carries an explicit <base>.
  try {
    if (document.querySelector("base[href]")) return;
    const head = document.head ?? document.documentElement;
    if (!head) return;
    const base = document.createElement("base");
    base.setAttribute("href", new URL(url).href);
    head.insertBefore(base, head.firstChild);
  } catch {
    // A missing head or an unparseable url only costs relative links.
  }
}

function documentTitle(document: ParsedDocument): string | undefined {
  const raw = document.title;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.replace(/\s+/g, " ").trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstNonEmpty(
  ...values: (string | null | undefined)[]
): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.replace(/\s+/g, " ").trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
    return `${host}.html`;
  } catch {
    return "page.html";
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function selectExtractor(ai: unknown): Extractor {
  if (ai && typeof (ai as WorkersAIToMarkdown).toMarkdown === "function") {
    return new WorkersAIExtractor(ai as WorkersAIToMarkdown);
  }
  return new ReadabilityExtractor();
}
