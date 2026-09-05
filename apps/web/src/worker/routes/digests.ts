import { Hono } from "hono";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import { digestItems, digests } from "@til/db";
import { ZodError } from "zod";
import type { AppContextEnv } from "../deps.js";
import { startDigestRun } from "../digest-run.js";
import { toDigestDetailDTO, toDigestSummaryDTO } from "../dto.js";
import { HttpError } from "../http-error.js";
import { runDigestSchema, type RunDigestBody } from "../schemas.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// A full run (4 parallel fetches + one LLM call, both with retries) finishes in
// minutes; past this the Workflow instance is gone and the row is a zombie.
const STALE_PENDING_MS = 15 * 60 * 1000;

// WHY: a LEFT JOIN + count, not a correlated subquery — drizzle renders raw `sql`
// columns unqualified in a single-table select, which silently counts nothing.
const itemCountSql = sql<number>`count(${digestItems.id})`;

async function sweepStalePending(
  deps: { db: AppContextEnv["Variables"]["deps"]["db"]; now: () => number },
  userId: string,
  id?: string,
): Promise<void> {
  const now = deps.now();
  const stale = and(
    eq(digests.userId, userId),
    eq(digests.status, "pending"),
    lt(digests.updatedAt, now - STALE_PENDING_MS),
  );
  await deps.db
    .update(digests)
    .set({ status: "failed", error: "digest run timed out", updatedAt: now })
    .where(id ? and(stale, eq(digests.id, id)) : stale);
}

export function createDigestsRouter() {
  const router = new Hono<AppContextEnv>();

  router.post("/run", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const body = await readRunBody(c.req.raw);
    const started = await startDigestRun(deps, userId, body);
    return c.json({ id: started.id }, 202);
  });

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const url = new URL(c.req.url);

    await sweepStalePending(deps, userId);

    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
    );

    const rows = await deps.db
      .select({
        id: digests.id,
        runAt: digests.runAt,
        windowDays: digests.windowDays,
        kind: digests.kind,
        status: digests.status,
        title: digests.title,
        intro: digests.intro,
        error: digests.error,
        createdAt: digests.createdAt,
        updatedAt: digests.updatedAt,
        itemCount: itemCountSql,
      })
      .from(digests)
      .leftJoin(digestItems, eq(digestItems.digestId, digests.id))
      .where(eq(digests.userId, userId))
      .groupBy(digests.id)
      .orderBy(desc(digests.runAt), desc(digests.id))
      .limit(limit);

    const items = rows.map(({ itemCount, ...row }) =>
      toDigestSummaryDTO(row, Number(itemCount ?? 0)),
    );
    return c.json({ items });
  });

  router.get("/:id", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    // WHY: without this the detail page polls a zombie run forever, since the
    // client only stops when status leaves 'pending'.
    await sweepStalePending(deps, userId, id);
    const rows = await deps.db
      .select()
      .from(digests)
      .where(and(eq(digests.id, id), eq(digests.userId, userId)))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "not_found", "Digest not found.");
    }
    // `digest_items` carries no user column: the parent digest was just verified
    // to be this user's, and every item hangs off it (migration 0012).
    const items = await deps.db
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, id))
      .orderBy(asc(digestItems.rank));
    return c.json(toDigestDetailDTO(row, items));
  });

  router.delete("/:id", async (c) => {
    const deps = c.get("deps");
    const userId = c.get("user").id;
    const id = c.req.param("id");
    const existing = await deps.db
      .select({ id: digests.id })
      .from(digests)
      .where(and(eq(digests.id, id), eq(digests.userId, userId)))
      .limit(1);
    if (!existing[0]) {
      throw new HttpError(404, "not_found", "Digest not found.");
    }
    // The items cascade off the digest row (FK, migration 0003).
    await deps.db
      .delete(digests)
      .where(and(eq(digests.id, id), eq(digests.userId, userId)));
    return c.body(null, 204);
  });

  return router;
}

// WHY: `POST /api/digests/run` is meaningful with no body at all (cron defaults),
// so an empty payload has to parse as `{}` instead of failing validation.
async function readRunBody(request: Request): Promise<RunDigestBody> {
  let raw = "";
  try {
    raw = await request.text();
  } catch {
    raw = "";
  }

  let parsed: unknown = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid request body: expected JSON.",
      );
    }
  }

  try {
    return runDigestSchema.parse(parsed);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "Invalid request body: windowDays must be 1-30, maxItems 1-25, and kind one of 'weekly' or 'monthly-report'.",
      );
    }
    throw err;
  }
}
