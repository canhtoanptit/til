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

function stripBlock(html: string, tag: string): string {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi");
  return html.replace(re, " ");
}

function htmlToPlainText(html: string): string {
  let out = html;
  for (const tag of ["script", "style", "noscript", "nav", "header", "footer", "aside"]) {
    out = stripBlock(out, tag);
  }
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  out = out.replace(/<(br|BR)\s*\/?>(?=\s|$|<)/g, "\n");
  out = out.replace(/<\/(p|div|section|article|li|h[1-6]|tr|td|th|blockquote)>/gi, "\n");
  out = out.replace(/<[^>]+>/g, " ");
  out = decodeEntities(out);
  out = out.replace(/\r\n/g, "\n");
  out = out.replace(/[ \t\f\v]+/g, " ");
  out = out.replace(/\n\s+/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

export class DevFallbackExtractor implements Extractor {
  async toMarkdown(
    html: string,
    _url: string,
  ): Promise<{ markdown: string; title?: string }> {
    const title = extractTitleFromHtml(html);
    const text = htmlToPlainText(html);
    if (text.length === 0) {
      throw new ExtractionError("Fallback extractor produced empty text.");
    }
    return { markdown: text, title };
  }
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
  return new DevFallbackExtractor();
}
