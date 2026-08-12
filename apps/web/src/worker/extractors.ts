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
import type { ExtractedDocument, Extractor } from "@til/core";
import { ExtractionError } from "@til/core";

interface MarkdownDocumentInput {
  name: string;
  blob: Blob;
}

/**
 * `ConversionResponse` from @cloudflare/workers-types, restated loosely on purpose
 * — every field optional, because this is a response from a service we do not
 * version and the failure mode we want is a readable ExtractionError, not a
 * TypeError on a field that moved.
 *
 * Verified 2026-08-12 against the installed @cloudflare/workers-types
 * (5.20260801.1) and the Workers AI markdown-conversion docs (binding reference
 * page, last updated 2026-07-13):
 *  - a single document in returns a single object, an array returns an array;
 *  - `format` is "markdown" on success, "text" with the newer `output.format`
 *    option, and "error" for a per-file failure;
 *  - a failed conversion does NOT throw — it comes back in-band as
 *    `{ format: "error", error }` with no `data`, which is why `convert` checks
 *    both;
 *  - the field is `mimeType`, camelCase. The docs' binding page spells it
 *    `mimetype`; the types, the REST response example and the launch changelog all
 *    say `mimeType`, so the docs page is the typo. We read neither.
 */
interface ConversionResult {
  id?: string;
  name?: string;
  format?: "markdown" | "text" | "error";
  mimeType?: string;
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

  async toMarkdown(html: string, url: string): Promise<ExtractedDocument> {
    const name = filenameFromUrl(url, "html");
    const blob = new Blob([html], { type: "text/html" });
    const markdown = await this.convert(name, blob);
    return { markdown, title: extractTitleFromHtml(html) };
  }

  /**
   * PDF → markdown, the reason PDFs are a cloud-stack-only feature (P25). The
   * binding is handed the bytes as a `Blob`, exactly like the HTML path — the only
   * things that change are the mime type and the `.pdf` filename.
   *
   * Verified 2026-08-12 against the Workers AI markdown-conversion docs:
   *  - the conversion is structural, not visual. Metadata, then each page in
   *    sequence, then the PDF's `StructTree` if it has one and the raw page text if
   *    it does not. There is no OCR and no vision model in the PDF path, so a
   *    scanned PDF has nothing to extract — hence the explicit empty-result message
   *    below rather than the generic one.
   *  - PDF conversion bills no neurons (only the *image* path runs models).
   *  - no input size limit is documented. That is "undocumented", not "unlimited",
   *    which is another reason to keep fetch-page's 5 MB cap in front of it.
   *  - per-format options exist but must be nested — `{ conversionOptions: { pdf:
   *    {...} } }`, not the options bare. We pass none: the defaults include the
   *    document metadata, which is useful context for a digest.
   */
  async documentToMarkdown(
    bytes: Uint8Array,
    url: string,
    mimeType: string,
  ): Promise<ExtractedDocument> {
    if (bytes.byteLength === 0) {
      throw new ExtractionError("The PDF response was empty.");
    }
    const name = filenameFromUrl(url, "pdf");
    const blob = new Blob([bytes], { type: mimeType });
    let markdown: string;
    try {
      markdown = await this.convert(name, blob);
    } catch (err) {
      if (err instanceof ExtractionError && /markdown was empty/i.test(err.message)) {
        throw new ExtractionError(
          "This PDF has no extractable text — a scanned PDF is a picture of a page, and PDF conversion does not run OCR.",
        );
      }
      throw err;
    }
    const title = firstHeading(markdown);
    return title === undefined ? { markdown } : { markdown, title };
  }

  private async convert(name: string, blob: Blob): Promise<string> {
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
      throw new ExtractionError(result.error ?? "toMarkdown returned no data.");
    }
    const markdown = result.data.trim();
    if (markdown.length === 0) {
      throw new ExtractionError("Extracted markdown was empty.");
    }
    return markdown;
  }
}

/**
 * A PDF has no `<title>`, so the first markdown heading is the closest thing to
 * one. Only a hint for the digest prompt — the stored title is whatever the LLM
 * writes — so guessing wrong is cheap and guessing nothing is fine.
 */
function firstHeading(markdown: string): string | undefined {
  const match = /^#{1,3}[ \t]+(.+)$/m.exec(markdown);
  const heading = match?.[1]?.replace(/\s+/g, " ").trim();
  if (heading === undefined || heading.length === 0) return undefined;
  return heading.length > 200 ? undefined : heading;
}

const ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * The handful of entities that show up in the text we lift out of markup with a
 * regex rather than a parser — page `<title>` here, and YouTube's caption XML in
 * youtube.ts, which is why this is exported rather than private.
 */
export function decodeEntities(input: string): string {
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

/**
 * The `name` the conversion is submitted under. The extension is not cosmetic —
 * it is part of how the service decides which converter to run — so it is passed
 * in rather than assumed, and a PDF's own filename is preferred when the URL has
 * one worth keeping.
 */
function filenameFromUrl(url: string, extension: "html" | "pdf"): string {
  try {
    const u = new URL(url);
    if (extension === "pdf") {
      const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
      const safe = decodeURI(last).replace(/[^a-z0-9._-]/gi, "_");
      if (/\.pdf$/i.test(safe) && safe.length <= 128) return safe;
    }
    const host = u.hostname.replace(/[^a-z0-9.-]/gi, "_") || "page";
    return `${host}.${extension}`;
  } catch {
    return `page.${extension}`;
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
