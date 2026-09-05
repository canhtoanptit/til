import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import {
  exportContentDisposition,
  exportContentType,
  exportFailureChunk,
  parseExportFormat,
  writeJsonExport,
  writeMarkdownExport,
} from "../export.js";

export function createExportRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const raw = new URL(c.req.url).searchParams.get("format");
    const format = parseExportFormat(raw);
    // Validated BEFORE the first byte: once the stream opens, `app.onError` can
    // no longer replace the response, so every rejection has to happen here.
    if (format === null) {
      throw new HttpError(
        422,
        "validation_error",
        `Unknown export format: ${raw ?? ""}. Use format=json or format=markdown.`,
      );
    }

    const exportedAt = deps.now();
    c.header("content-type", exportContentType(format));
    c.header(
      "content-disposition",
      exportContentDisposition(format, exportedAt),
    );
    // WHY Identity: Hono's own guidance for the streaming helper on Cloudflare
    // Workers — without it, streaming misbehaves behind wrangler (verified against
    // hono 4.12.33 docs at build time).
    c.header("content-encoding", "Identity");
    // A backup must be the library as it is now, never a proxy's copy of it.
    c.header("cache-control", "no-store");

    return stream(c, async (s) => {
      try {
        if (format === "markdown") {
          await writeMarkdownExport(deps.db, userId, exportedAt, s);
        } else {
          await writeJsonExport(deps.db, userId, exportedAt, s);
        }
      } catch (err) {
        // The status line said 200 several kilobytes ago, so the only place left
        // to report a failure is the file itself. `exportFailureChunk` writes a
        // marker that is deliberately not valid JSON.
        //
        // Caught here rather than passed to `stream`'s own `onError`: that hook
        // only fires for `e instanceof Error`, so a thrown string would close the
        // stream cleanly and hand the owner a truncated file that looks complete.
        console.error("[export] stream failed:", err);
        await s.write(exportFailureChunk(err));
      }
    });
  });

  return router;
}
