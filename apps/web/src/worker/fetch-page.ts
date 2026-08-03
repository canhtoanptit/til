import { assertSafeUrl, ExtractionError } from "@til/core";

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TIL/0.1";
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15_000;

export interface FetchedPage {
  html: string;
  finalUrl: string;
}

/**
 * Fetches the URL enforcing a 15s timeout, 5MB size cap, html/text content-type,
 * and re-runs the SSRF safety check on the final redirected URL.
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
      accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
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

  const contentType = response.headers.get("content-type") ?? "";
  const lower = contentType.toLowerCase();
  if (!lower.includes("html") && !lower.includes("text/")) {
    throw new ExtractionError(`Unsupported content-type: ${contentType}`);
  }

  const declaredLen = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLen) && declaredLen > MAX_BYTES) {
    throw new ExtractionError(
      `Content-length ${declaredLen} exceeds ${MAX_BYTES} byte cap.`,
    );
  }

  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (text.length > MAX_BYTES) {
      throw new ExtractionError("Response exceeded 5 MB cap.");
    }
    return { html: text, finalUrl };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try {
        await reader.cancel();
      } catch {
        // best-effort
      }
      throw new ExtractionError("Response exceeded 5 MB cap.");
    }
    chunks.push(value);
  }
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.byteLength;
  }
  const html = new TextDecoder("utf-8").decode(buffer);
  return { html, finalUrl };
}
