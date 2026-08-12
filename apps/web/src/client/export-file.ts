export type ExportFormat = "json" | "markdown";

/**
 * The filename the server put on the attachment. It is the authority — the dated
 * name is stamped from the same clock as `exportedAt` inside the file — so the
 * client parses it rather than inventing a second one that could disagree.
 *
 * Both spellings are handled because `Content-Disposition` allows both:
 * `filename="x"` and the RFC 5987 `filename*=UTF-8''x`. The worker only ever
 * sends the plain form; the star form is read anyway so a future rename cannot
 * silently downgrade every download to the fallback.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null;

  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      const decoded = decodeURIComponent(star[1].trim());
      if (isSafeFilename(decoded)) return decoded;
    } catch {
      // Malformed percent-encoding — fall through to the plain form.
    }
  }

  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]*))/.exec(header);
  const raw = (plain?.[1] ?? plain?.[2] ?? "").trim();
  return isSafeFilename(raw) ? raw : null;
}

/**
 * A response header is remote input, and this value goes straight into a download
 * attribute. Anything with a path separator or a control character is refused, so
 * the caller falls back to a name it built itself.
 *
 * Spelled with char codes rather than a regex on purpose: a control-character
 * class means literal control bytes in the source file, and this repo has already
 * been bitten once by a stray NUL turning a source file into a binary blob as far
 * as git is concerned.
 */
function isSafeFilename(name: string): boolean {
  if (name.length === 0 || name.length > 255) return false;
  if (name === "." || name === "..") return false;
  if (name.includes("/") || name.includes("\\")) return false;
  for (let i = 0; i < name.length; i++) {
    const code = name.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Only used when the response arrives without a usable `Content-Disposition`.
 * UTC, matching the worker, so the fallback and the real thing agree on the date.
 */
export function fallbackExportFilename(
  format: ExportFormat,
  now: number,
): string {
  const date = new Date(now).toISOString().slice(0, 10);
  return `til-export-${date}.${format === "markdown" ? "md" : "json"}`;
}

export function exportFormatLabel(format: ExportFormat): string {
  return format === "markdown" ? "Markdown bundle" : "JSON backup";
}

/**
 * Hands a Blob to the browser's downloader.
 *
 * WHY this exists at all instead of an `<a href="/api/export">`: every API call
 * carries the app token in an `Authorization` header (see `api.ts`), and a plain
 * link cannot set headers. The alternative would be a token in the query string —
 * which is exactly what this app refuses to do elsewhere, because a URL ends up in
 * browser history and access logs. So the download is a normal authenticated
 * `fetch`, and the response body becomes an object URL here.
 *
 * The cost is honest and bounded: the browser holds the export in memory while the
 * worker streams it out. That asymmetry is the point — a browser has gigabytes to
 * spare, a Worker has ~128 MB, and the side that would fall over is the one that
 * streams.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Deferred: revoking synchronously can cancel the download the browser has
    // only just been asked to start.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
