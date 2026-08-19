/**
 * What kind of thing an entry points at (P25). `article` is the original and
 * only behaviour, so it is also the fallback everywhere: an unknown column
 * value, a hand-written row, a URL nobody recognises — all read as `article`.
 */
export type ContentType = "article" | "pdf" | "video";

export const CONTENT_TYPES: readonly ContentType[] = [
  "article",
  "pdf",
  "video",
];

export const DEFAULT_CONTENT_TYPE: ContentType = "article";

export function isContentType(raw: unknown): raw is ContentType {
  return raw === "article" || raw === "pdf" || raw === "video";
}

/**
 * Reads a stored/transported value back. The column has no CHECK constraint, so
 * anything is possible in it; `article` is the safe reading, because it is what
 * every row written before this column existed means.
 */
export function normalizeContentType(raw: unknown): ContentType {
  return isContentType(raw) ? raw : DEFAULT_CONTENT_TYPE;
}

/**
 * Hosts whose watch pages we treat as video. Matched exactly, or as
 * `<sub>.youtube.com` — never by `endsWith("youtube.com")`, which would hand
 * `notyoutube.com` and `youtube.com.evil.test` the video path and, with it, a
 * transcript fetch aimed at a stranger's server.
 */
const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
  "youtu.be",
  "www.youtu.be",
]);

/**
 * Whether a hostname is one of YouTube's own. Also the allowlist the transcript
 * fetch checks a caption `baseUrl` against: that URL is read out of untrusted page
 * JSON, so without this the watch page gets to choose which host our Worker talks
 * to — an SSRF with our egress and our timeouts.
 */
export function isYoutubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (YOUTUBE_HOSTS.has(host)) return true;
  return (
    host.endsWith(".youtube.com") || host.endsWith(".youtube-nocookie.com")
  );
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{5,64}$/;

/**
 * The video id in a YouTube watch URL, or null if this is not one. Deliberately
 * strict about *shape* rather than length: ids have been 11 characters for years
 * but that is a YouTube implementation detail, not a contract, and the id is only
 * ever used to build a `youtube.com/watch` URL we then re-validate.
 *
 * Recognised: `/watch?v=ID` (any youtube host), `youtu.be/ID`, `/shorts/ID`,
 * `/live/ID`, `/embed/ID`.
 */
export function youtubeVideoId(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") return null;
  const host = parsed.hostname.toLowerCase();
  if (!isYoutubeHost(host)) return null;

  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);

  // youtu.be/ID — the whole path is the id.
  if (host === "youtu.be" || host === "www.youtu.be") {
    return segments.length === 1 ? validId(segments[0]) : null;
  }

  if (segments.length === 1 && segments[0] === "watch") {
    return validId(parsed.searchParams.get("v"));
  }
  if (segments.length === 2) {
    const [prefix, id] = segments;
    if (prefix === "shorts" || prefix === "live" || prefix === "embed") {
      return validId(id);
    }
  }
  return null;
}

function validId(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  return YOUTUBE_ID.test(raw) ? raw : null;
}

/** The canonical watch page for an id — what the transcript fetch asks for. */
export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function hasPdfExtension(pathname: string): boolean {
  return /\.pdf$/i.test(decodeURIComponentSafe(pathname));
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The URL-phase guess, made the moment a link is saved so the UI can say
 * "video"/"pdf" while the entry is still pending. It sees only the URL, so it is
 * a guess by construction: `refineContentType` gets the last word once the
 * response's own `content-type` header is in hand.
 */
export function detectContentTypeFromUrl(rawUrl: string): ContentType {
  if (youtubeVideoId(rawUrl) !== null) return "video";
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return DEFAULT_CONTENT_TYPE;
  }
  if (hasPdfExtension(parsed.pathname)) return "pdf";
  return DEFAULT_CONTENT_TYPE;
}

/** Whether a `content-type` header value names a PDF. */
export function isPdfMediaType(header: string | null | undefined): boolean {
  if (typeof header !== "string") return false;
  const essence = header.split(";")[0]?.trim().toLowerCase() ?? "";
  return essence === "application/pdf" || essence === "application/x-pdf";
}

/**
 * The URL guess refined by what the server actually served.
 *
 * Both directions matter. `arxiv.org/pdf/2401.00001` has no `.pdf` extension and
 * still serves one, so a header can promote an `article` to `pdf`; a `.pdf` link
 * that answers with HTML is a landing page or an interstitial, so a header can
 * demote a `pdf` guess back to `article`. A `video` guess is never touched — the
 * transcript path never reaches a fetch whose content-type we would consult.
 */
export function refineContentType(
  guess: ContentType,
  responseContentType: string | null | undefined,
): ContentType {
  if (guess === "video") return "video";
  return isPdfMediaType(responseContentType) ? "pdf" : "article";
}
