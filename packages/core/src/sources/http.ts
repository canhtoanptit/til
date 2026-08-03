import { SourceError } from "../errors.js";
import { assertSafeUrl } from "../url.js";

export const SOURCE_USER_AGENT =
  "TIL-digest/0.1 (personal link digest; +https://github.com/canhtoanptit/til)";

export const SOURCE_TIMEOUT_MS = 10_000;

export const JSON_ACCEPT = "application/json";

export const XML_ACCEPT =
  "application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8";

const DAY_MS = 86_400_000;

const SNIPPET_MAX_CHARS = 600;

export interface SourceRequestOptions {
  source: string;
  accept: string;
  fetchImpl?: typeof fetch;
}

async function request(
  url: string,
  opts: SourceRequestOptions,
): Promise<Response> {
  const impl = opts.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await impl(url, {
      method: "GET",
      headers: {
        "user-agent": SOURCE_USER_AGENT,
        accept: opts.accept,
      },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new SourceError(
      opts.source,
      `${opts.source}: request to ${url} failed: ${describeError(err)}`,
    );
  }
  if (!response.ok) {
    throw new SourceError(
      opts.source,
      `${opts.source}: request to ${url} failed with HTTP ${response.status}`,
    );
  }
  return response;
}

export async function fetchSourceJson(
  url: string,
  opts: { source: string; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const response = await request(url, { ...opts, accept: JSON_ACCEPT });
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new SourceError(
      opts.source,
      `${opts.source}: response from ${url} was not valid JSON`,
    );
  }
}

export async function fetchSourceText(
  url: string,
  opts: { source: string; fetchImpl?: typeof fetch; accept?: string },
): Promise<string> {
  const response = await request(url, {
    source: opts.source,
    fetchImpl: opts.fetchImpl,
    accept: opts.accept ?? XML_ACCEPT,
  });
  try {
    return await response.text();
  } catch {
    throw new SourceError(
      opts.source,
      `${opts.source}: response body from ${url} could not be read`,
    );
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function windowStart(now: number, windowDays: number): number {
  return now - Math.max(0, windowDays) * DAY_MS;
}

export function isWithinWindow(
  publishedAt: number,
  now: number,
  windowDays: number,
): boolean {
  return publishedAt >= windowStart(now, windowDays);
}

export function isSafeCandidateUrl(url: string): boolean {
  try {
    assertSafeUrl(url);
    return true;
  } catch {
    return false;
  }
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// Source-supplied snippets (HN story_text, Lobsters/RSS descriptions) arrive as
// HTML fragments; the digest prompt wants plain prose, so drop tags and cap length.
export function cleanSnippet(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = collapseWhitespace(raw.replace(/<[^>]*>/g, " "));
  if (text.length === 0) return undefined;
  return text.length > SNIPPET_MAX_CHARS
    ? `${text.slice(0, SNIPPET_MAX_CHARS).trimEnd()}…`
    : text;
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : undefined;
}

export function defaultNow(): number {
  return Date.now();
}
