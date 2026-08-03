import { Hono } from "hono";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { entries } from "@til/db";
import { UnsafeUrlError, assertSafeUrl, normalizeUrl } from "@til/core";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import { createEntrySchema } from "../schemas.js";
import { toEntryDTO, toEntryDetailDTO } from "../dto.js";
import { ingestEntry } from "../ingest.js";

const STALE_PENDING_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseCursor(raw: string | undefined): { createdAt: number; id: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf("_");
  if (idx <= 0) return null;
  const ts = Number(raw.slice(0, idx));
  const id = raw.slice(idx + 1);
  if (!Number.isFinite(ts) || id.length === 0) return null;
  return { createdAt: ts, id };
}

function encodeCursor(createdAt: number, id: string): string {
  return `${createdAt}_${id}`;
}

export function createEntriesRouter() {
  const router = new Hono<AppContextEnv>();

  router.post(
    "/",
    zValidator("json", createEntrySchema, (result) => {
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

      let normalized;
      try {
        normalized = normalizeUrl(raw);
      } catch {
        throw new HttpError(400, "invalid_url", `Invalid URL: ${raw}`);
      }

      try {
        assertSafeUrl(normalized.url);
      } catch (err) {
        if (err instanceof UnsafeUrlError) {
          throw new HttpError(400, "unsafe_url", err.message);
        }
        throw new HttpError(400, "invalid_url", `Invalid URL: ${raw}`);
      }

      const existing = await deps.db
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.canonicalUrl, normalized.canonicalUrl))
        .limit(1);
      const dup = existing[0];
      if (dup) {
        throw new HttpError(
          409,
          "duplicate_url",
          "URL already exists.",
          { existingId: dup.id },
        );
      }

      const id = crypto.randomUUID();
      const now = deps.now();
      await deps.db.insert(entries).values({
        id,
        url: normalized.url,
        canonicalUrl: normalized.canonicalUrl,
        sourceDomain: normalized.sourceDomain,
        tags: "[]",
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });

      deps.waitUntil(ingestEntry(deps, id));

      return c.json({ id, status: "pending" as const }, 201);
    },
  );

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const url = new URL(c.req.url);

    const now = deps.now();
    const staleBefore = now - STALE_PENDING_MS;
    await deps.db
      .update(entries)
      .set({ status: "failed", error: "ingest timed out", updatedAt: now })
      .where(and(eq(entries.status, "pending"), lt(entries.updatedAt, staleBefore)));

    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
    );
    const cursor = parseCursor(url.searchParams.get("cursor") ?? undefined);

    const where = cursor
      ? or(
          lt(entries.createdAt, cursor.createdAt),
          and(
            eq(entries.createdAt, cursor.createdAt),
            lt(entries.id, cursor.id),
          ),
        )
      : undefined;

    const rows = await deps.db
      .select()
      .from(entries)
      .where(where)
      .orderBy(desc(entries.createdAt), desc(entries.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const items = page.map(toEntryDTO);
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

    return c.json({ items, nextCursor });
  });

  router.get("/:id", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    // WHY: without this the detail page polls a zombie ingest forever, since the
    // client only stops polling when status leaves 'pending'.
    const sweepNow = deps.now();
    await deps.db
      .update(entries)
      .set({ status: "failed", error: "ingest timed out", updatedAt: sweepNow })
      .where(
        and(
          eq(entries.id, id),
          eq(entries.status, "pending"),
          lt(entries.updatedAt, sweepNow - STALE_PENDING_MS),
        ),
      );
    const rows = await deps.db
      .select()
      .from(entries)
      .where(eq(entries.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "not_found", "Entry not found.");
    }
    return c.json(toEntryDetailDTO(row));
  });

  router.delete("/:id", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const existing = await deps.db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.id, id))
      .limit(1);
    if (!existing[0]) {
      throw new HttpError(404, "not_found", "Entry not found.");
    }
    await deps.db.delete(entries).where(eq(entries.id, id));
    if (deps.vectorize) {
      try {
        await deps.vectorize.deleteByIds([id]);
      } catch (err) {
        console.warn(
          `[delete ${id}] vectorize deleteByIds failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.body(null, 204);
  });

  router.post("/:id/reingest", async (c) => {
    const deps = c.get("deps");
    const id = c.req.param("id");
    const rows = await deps.db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.id, id))
      .limit(1);
    if (!rows[0]) {
      throw new HttpError(404, "not_found", "Entry not found.");
    }
    const now = deps.now();
    await deps.db
      .update(entries)
      .set({ status: "pending", error: null, updatedAt: now })
      .where(eq(entries.id, id));
    deps.waitUntil(ingestEntry(deps, id));
    return c.json({ id, status: "pending" as const }, 202);
  });

  return router;
}

// re-export helpers for tests
export { encodeCursor, parseCursor, sql };
