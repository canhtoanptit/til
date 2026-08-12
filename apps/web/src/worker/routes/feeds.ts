import { Hono } from "hono";
import { asc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { feeds } from "@til/db";
import { UnsafeUrlError, assertSafeUrl } from "@til/core";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import { createFeedSchema, updateFeedSchema } from "../schemas.js";
import { toFeedDTO } from "../dto.js";

/**
 * The stored form of a feed url. `assertSafeUrl` is the same SSRF guard the
 * capture flow uses, and the URL it parsed is what gets stored — so `HTTPS://Jvns.ca/…`
 * and `https://jvns.ca/…` collide on `feeds_url_uq` instead of becoming two rows
 * that poll the same feed twice.
 *
 * Deliberately NOT `normalizeUrl`: that drops a trailing slash to build the
 * canonical form, and in `https://blog.cloudflare.com/rss/` the slash is part of
 * the path the origin serves.
 */
function toStoredFeedUrl(raw: string): string {
  const trimmed = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, "invalid_url", `Invalid URL: ${raw}`);
  }
  try {
    assertSafeUrl(parsed.toString());
  } catch (err) {
    if (err instanceof UnsafeUrlError) {
      throw new HttpError(400, "unsafe_url", err.message);
    }
    throw new HttpError(400, "invalid_url", `Invalid URL: ${raw}`);
  }
  return parsed.toString();
}

export function createFeedsRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const rows = await deps.db
      .select()
      .from(feeds)
      .orderBy(asc(feeds.createdAt), asc(feeds.id));
    return c.json({ items: rows.map(toFeedDTO) });
  });

  router.post(
    "/",
    zValidator("json", createFeedSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: url is required.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const { url: raw } = c.req.valid("json");
      const url = toStoredFeedUrl(raw);

      const existing = await deps.db
        .select({ id: feeds.id })
        .from(feeds)
        .where(eq(feeds.url, url))
        .limit(1);
      const dup = existing[0];
      if (dup) {
        throw new HttpError(409, "duplicate_url", "Feed already exists.", {
          existingId: dup.id,
        });
      }

      const id = crypto.randomUUID();
      const now = deps.now();
      const row = {
        id,
        url,
        title: null,
        enabled: true,
        createdAt: now,
        updatedAt: now,
      };
      await deps.db.insert(feeds).values(row);
      return c.json(toFeedDTO(row), 201);
    },
  );

  router.put(
    "/:id",
    zValidator("json", updateFeedSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: enabled must be a boolean.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const id = c.req.param("id");
      const { enabled } = c.req.valid("json");

      const rows = await deps.db
        .select()
        .from(feeds)
        .where(eq(feeds.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HttpError(404, "not_found", "Feed not found.");
      }

      const updatedAt = deps.now();
      await deps.db
        .update(feeds)
        .set({ enabled, updatedAt })
        .where(eq(feeds.id, id));
      return c.json(toFeedDTO({ ...row, enabled, updatedAt }));
    },
  );

  router.delete("/:id", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const existing = await deps.db
      .select({ id: feeds.id })
      .from(feeds)
      .where(eq(feeds.id, id))
      .limit(1);
    if (!existing[0]) {
      throw new HttpError(404, "not_found", "Feed not found.");
    }
    await deps.db.delete(feeds).where(eq(feeds.id, id));
    return c.body(null, 204);
  });

  return router;
}
