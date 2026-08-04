import { Hono } from "hono";
import { ZodError } from "zod";
import { createBearerAuth } from "./auth.js";
import { HttpError } from "./http-error.js";
import type { AppContextEnv, Deps } from "./deps.js";
import { createDigestsRouter } from "./routes/digests.js";
import { createEntriesRouter } from "./routes/entries.js";
import { createSearchRouter } from "./routes/search.js";
import { createSettingsRouter } from "./routes/settings.js";

export function createApp(depsFor: (c: { env: unknown; executionCtx: unknown }) => Deps) {
  const app = new Hono<AppContextEnv>();

  app.use("*", async (c, next) => {
    let executionCtx: unknown = null;
    try {
      executionCtx = c.executionCtx;
    } catch {
      executionCtx = null;
    }
    c.set("deps", depsFor({ env: c.env, executionCtx }));
    await next();
  });

  app.use("*", createBearerAuth<AppContextEnv>());

  app.get("/api/health", async (c) => {
    const deps = c.get("deps");
    // WHY: unauthenticated, and the only place the silent "entries are saved but
    // unindexed" failure of ADR-0010 becomes visible — so it must never throw.
    let embedder: "ok" | "unavailable" = "unavailable";
    try {
      embedder = await deps.probeEmbedder();
    } catch {
      embedder = "unavailable";
    }
    return c.json({ ok: true, stack: deps.stack, embedder });
  });

  app.route("/api/entries", createEntriesRouter());
  app.route("/api/search", createSearchRouter());
  app.route("/api/settings", createSettingsRouter());
  app.route("/api/digests", createDigestsRouter());

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(err.toBody(), err.status as 400);
    }
    if (err instanceof ZodError) {
      return c.json(
        {
          error: {
            code: "validation_error" as const,
            message: "Invalid request body.",
          },
        },
        422,
      );
    }
    console.error("[worker] unhandled error:", err);
    const message = err instanceof Error ? err.message : String(err);
    return c.json(
      { error: { code: "llm_error" as const, message } },
      500,
    );
  });

  return app;
}
