import { Hono } from "hono";
import { and, desc, eq, like, lt, or, sql, type SQL } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { entries } from "@til/db";
import {
  UnsafeUrlError,
  assertSafeUrl,
  detectContentTypeFromUrl,
  normalizeUrl,
} from "@til/core";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import { createEntrySchema, updateEntrySchema } from "../schemas.js";
import { toEntryDTO, toEntryDetailDTO, toRelatedEntryDTO } from "../dto.js";
import { ingestEntry } from "../ingest.js";
import { reembedEntries } from "../indexing.js";
import { normalizeTag, relatedEntryRows, tagPattern } from "../retrieval.js";

const STALE_PENDING_MS = 10 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Which slice of the library `GET /api/entries` should return. */
export type EntryFilter = "all" | "favorites" | "archived";

/**
 * Unknown values read as "all" rather than 422, matching how every other query
 * param on this route already behaves (a bad `limit` clamps, a bad `cursor` is
 * ignored). The UI only ever sends the three known values.
 */
export function parseEntryFilter(raw: string | null | undefined): EntryFilter {
  return raw === "favorites" || raw === "archived" ? raw : "all";
}

/**
 * WHY "all" is not literally everything: archiving exists precisely to get an
 * entry out of the default view, so the unfiltered feed excludes archived rows and
 * the Archived chip is the only way to see them. Favorites excludes them too —
 * archiving is the stronger statement of the two.
 */
function filterPredicates(filter: EntryFilter): SQL[] {
  switch (filter) {
    case "favorites":
      return [eq(entries.favorite, true), eq(entries.archived, false)];
    case "archived":
      return [eq(entries.archived, true)];
    case "all":
      return [eq(entries.archived, false)];
  }
}

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
      const contentType = detectContentTypeFromUrl(normalized.url);
      await deps.db.insert(entries).values({
        id,
        url: normalized.url,
        canonicalUrl: normalized.canonicalUrl,
        sourceDomain: normalized.sourceDomain,
        tags: "[]",
        // The URL-phase guess, stored now so a pending video or PDF is badged the
        // moment it appears in the feed. Ingest overwrites it with what the fetch
        // turned out to be — see `refineContentType`.
        contentType,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });

      deps.waitUntil(ingestEntry(deps, id));

      // `contentType` rides along so the client's optimistic pending card carries
      // the badge immediately, without a second round-trip. Additive.
      return c.json({ id, status: "pending" as const, contentType }, 201);
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

    const keyset = cursor
      ? or(
          lt(entries.createdAt, cursor.createdAt),
          and(
            eq(entries.createdAt, cursor.createdAt),
            lt(entries.id, cursor.id),
          ),
        )
      : undefined;

    // The filter and tag predicates AND with the keyset one, so pagination stays
    // correct per view: the cursor walks the filtered sequence, not the whole feed.
    const filter = parseEntryFilter(url.searchParams.get("filter"));
    const tag = normalizeTag(url.searchParams.get("tag") ?? undefined);
    const where = and(
      ...filterPredicates(filter),
      tag === null ? undefined : like(entries.tags, tagPattern(tag)),
      keyset,
    );

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

  router.get("/:id/related", async (c) => {
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
    const url = new URL(c.req.url);
    const limitRaw = url.searchParams.get("limit");
    const related = await relatedEntryRows(deps, {
      id,
      ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
    });
    return c.json({
      available: related.available,
      items: related.items.map(({ row, score }) =>
        toRelatedEntryDTO(row, score),
      ),
    });
  });

  /**
   * The owner's marks on an entry — the first mutation here that is not a delete.
   *
   * Partial by construction: an omitted field is left exactly as it was, so a star
   * click cannot clobber a note the user is mid-way through typing in another tab.
   * The one asymmetry is `note: ""`, which clears the column back to NULL — an
   * emptied textarea is the gesture that means "I don't have a note", and keeping
   * "" out of the column leaves "no note" with a single representation.
   */
  router.patch(
    "/:id",
    zValidator("json", updateEntrySchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: send at least one of favorite (boolean), archived (boolean) or note (string).",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const id = c.req.param("id");
      const body = c.req.valid("json");

      const rows = await deps.db
        .select()
        .from(entries)
        .where(eq(entries.id, id))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HttpError(404, "not_found", "Entry not found.");
      }

      const changes: {
        favorite?: boolean;
        archived?: boolean;
        note?: string | null;
      } = {};
      if (body.favorite !== undefined) changes.favorite = body.favorite;
      if (body.archived !== undefined) changes.archived = body.archived;
      if (body.note !== undefined) {
        changes.note = body.note.length === 0 ? null : body.note;
      }

      const updatedAt = deps.now();
      await deps.db
        .update(entries)
        .set({ ...changes, updatedAt })
        .where(eq(entries.id, id));
      // The detail shape, a superset of EntryDTO: the detail page is the only
      // caller that owns a cached entry, and it must not lose contentMarkdown to
      // the response of a star click.
      return c.json(toEntryDetailDTO({ ...row, ...changes, updatedAt }));
    },
  );

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
    // WHY: `entry_vectors` rows also cascade off entries.id, but Vectorize has no
    // foreign keys — the explicit delete is what keeps `cloud` mode consistent.
    if (deps.vectorStore) {
      try {
        await deps.vectorStore.deleteByIds([id]);
      } catch (err) {
        console.warn(
          `[delete ${id}] vector delete failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    return c.body(null, 204);
  });

  // Backfill for entries captured while no embedder was reachable. Declared
  // before "/:id/reingest" only for readability; the paths cannot collide.
  router.post("/reembed", async (c) => {
    const deps = c.get("deps");
    const result = await reembedEntries(deps, {});
    return c.json(result);
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
