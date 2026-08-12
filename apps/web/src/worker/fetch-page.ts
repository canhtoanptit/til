import { assertSafeUrl, ExtractionError, refineContentType } from "@til/core";
import type { ContentType } from "@til/core";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TIL/0.1";
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export { MAX_BYTES as MAX_FETCH_BYTES };

export interface FetchedPage {
  /**
   * The decoded response text. Empty string when `contentType` is "pdf" — a PDF
   * is bytes, and decoding one as UTF-8 produces mojibake nobody wants; `bytes`
   * carries it instead.
   */
  html: string;
  finalUrl: string;
  /**
   * What the response actually was, per its own `content-type` header — the
   * fetch-time half of content-type detection (P25).
   *
   * Optional so that every hand-written `FetchPageFn` stub predating this stays
   * valid; absent reads as "article", which is what those stubs return.
   */
  contentType?: ContentType;
  /** The raw response body. Present only when `contentType` is "pdf". */
  bytes?: Uint8Array;
}

/**
 * Fetches the URL enforcing a 15s timeout, 5MB size cap, an html/text/pdf
 * content-type, and re-runs the SSRF safety check on the final redirected URL.
 *
 * The content-type header does double duty: it is still the gate that rejects a
 * response we cannot read at all, and it is now also the evidence that decides
 * between `article` and `pdf`. That is why the refinement lives here rather than
 * in ingest — this is the only place the header is in scope, and the alternative
 * (a HEAD request first) would double the round-trips to every site we ingest for
 * a header plenty of servers get wrong on HEAD anyway.
 */
export async function fetchPage(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FetchedPage> {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": DEFAULT_UA,
      accept:
        "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.9,*/*;q=0.8",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new ExtractionError(
      `Fetch failed with HTTP ${response.status} ${response.statusText}`,
    );
  }

  const finalUrl = response.url || url;
  assertSafeUrl(finalUrl);

  const header = response.headers.get("content-type") ?? "";
  const contentType = refineContentType("article", header);
  const lower = header.toLowerCase();
  if (
    contentType !== "pdf" &&
    !lower.includes("html") &&
    !lower.includes("text/")
  ) {
    throw new ExtractionError(`Unsupported content-type: ${header}`);
  }

  const declaredLen = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
    throw new ExtractionError(
      `Content-length ${declaredLen} exceeds ${MAX_BYTES} byte cap.`,
    );
  }

  const bytes = await readCapped(response, MAX_BYTES);
  if (contentType === "pdf") {
    return { html: "", finalUrl, contentType, bytes };
  }
  return {
    html: new TextDecoder("utf-8").decode(bytes),
    finalUrl,
    contentType,
  };
}

/**
 * Drains a response body, aborting as soon as it passes `maxBytes` rather than
 * after — a `content-length` header is a claim, not a promise, so the streaming
 * cap is the one that actually holds. Shared with the YouTube path, which fetches
 * two untrusted bodies of its own.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new ExtractionError(`Response exceeded ${maxBytes} byte cap.`);
    }
    return buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
      throw new ExtractionError(`Response exceeded ${maxBytes} byte cap.`);
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.byteLength;
  }
  return buffer;
}

/** Reads a capped body as UTF-8 text — the YouTube path's shape of the above. */
export async function readCappedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  return new TextDecoder("utf-8").decode(await readCapped(response, maxBytes));
}
