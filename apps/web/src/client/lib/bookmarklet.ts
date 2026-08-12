/**
 * The bookmarklet + the `?add=` capture flow it drives (C16).
 *
 * Both halves are pure string functions on purpose: the snippet must never grow a
 * dependency on the app's auth state. The bookmarklet only ever navigates to
 * `{origin}/?add={url}` — the app token stays in the browser's localStorage on
 * this origin and the TokenGate in front of the app is what authorises the save.
 * Putting a token in the snippet would paste a bearer credential into every
 * bookmarks file it is copied to.
 */

/** Only the origin is interpolated into the snippet, so its quoting cannot break. */
function toOrigin(appUrl: string): string | null {
  try {
    const { origin, protocol } = new URL(appUrl);
    if (protocol !== "http:" && protocol !== "https:") return null;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The `javascript:` snippet the owner saves as a bookmark. Opens the app in a new
 * tab with the current page's url in `?add=`, leaving the article they are reading
 * where it is. Returns null when `appUrl` is not an http(s) url to interpolate.
 */
export function bookmarkletHref(appUrl: string): string | null {
  const origin = toOrigin(appUrl);
  if (origin === null) return null;
  return `javascript:(function(){window.open('${origin}/?add='+encodeURIComponent(location.href),'_blank');})();`;
}

export interface AddParam {
  /** The raw (trimmed) value, ready to put in the capture input. */
  url: string;
  /**
   * True when the value is an http(s) url the capture flow can post as-is. False
   * means "pre-fill it and let the owner fix it" rather than posting something the
   * API would only reject.
   */
  autoSubmit: boolean;
}

/**
 * Reads `?add=` off a location search string. Returns null when the parameter is
 * absent or blank, so a plain visit to `/` is never treated as a capture.
 */
export function readAddParam(search: string): AddParam | null {
  const raw = new URLSearchParams(search).get("add");
  if (raw === null) return null;
  const url = raw.trim();
  if (url.length === 0) return null;
  return { url, autoSubmit: isHttpUrl(url) };
}

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
