import { Hono } from "hono";
import { and, asc, count, eq, isNull, lte, or } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { entries, reviews } from "@til/db";
import { initialReviewCard, isReviewGrade, scheduleReview } from "@til/core";
import type { AppContextEnv, Deps } from "../deps.js";
import { HttpError } from "../http-error.js";
import { enrollReviewSchema, gradeReviewSchema } from "../schemas.js";
import {
  normalizeReviewState,
  toReviewQueueItemDTO,
  toReviewScheduleDTO,
} from "../dto.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// WHY: D1 caps a statement at 100 bound parameters, and each enrolled card binds
// six, so "enroll everything" has to go out in small batches or it fails in the
// cloud stack exactly when a library is big enough to be worth reviewing.
const ENROLL_CHUNK = 10;

/** A card with no dueAt has never been scheduled, so it counts as due. */
function dueFilter(now: number) {
  return or(isNull(reviews.dueAt), lte(reviews.dueAt, now));
}

async function countDue(deps: Deps, now: number): Promise<number> {
  const rows = await deps.db
    .select({ n: count() })
    .from(reviews)
    .where(dueFilter(now));
  return Number(rows[0]?.n ?? 0);
}

export function createReviewsRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/queue", async (c) => {
    const deps = c.get("deps");
    const url = new URL(c.req.url);
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(
        1,
        Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : DEFAULT_LIMIT,
      ),
    );
    const now = deps.now();

    // The selected columns ARE the leak boundary: takeaway/summary/tags/markdown
    // are never read here, so the reveal cannot arrive with the question.
    const rows = await deps.db
      .select({
        entryId: reviews.entryId,
        state: reviews.state,
        dueAt: reviews.dueAt,
        intervalDays: reviews.intervalDays,
        ease: reviews.ease,
        lapses: reviews.lapses,
        title: entries.title,
        question: entries.question,
        url: entries.url,
        sourceDomain: entries.sourceDomain,
      })
      .from(reviews)
      .innerJoin(entries, eq(entries.id, reviews.entryId))
      .where(dueFilter(now))
      // Longest-overdue first; entryId only to make ties deterministic.
      .orderBy(asc(reviews.dueAt), asc(reviews.entryId))
      .limit(limit);

    return c.json({
      items: rows.map(toReviewQueueItemDTO),
      dueCount: await countDue(deps, now),
    });
  });

  // Declared before "/:entryId" because Hono matches in registration order and a
  // literal path would otherwise be swallowed by the parameter route.
  router.post(
    "/enroll",
    zValidator("json", enrollReviewSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: provide exactly one of entryId or all: true.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const body = c.req.valid("json");
      const now = deps.now();
      const fresh = initialReviewCard(now);

      if (body.entryId !== undefined) {
        const entryId = body.entryId;
        const entry = await deps.db
          .select({ id: entries.id })
          .from(entries)
          .where(eq(entries.id, entryId))
          .limit(1);
        if (!entry[0]) {
          throw new HttpError(404, "not_found", "Entry not found.");
        }
        // WHY: onConflictDoNothing, not an upsert — re-enrolling a card the user has
        // already been reviewing must not wipe its interval, ease or lapse history.
        const existing = await deps.db
          .select({ entryId: reviews.entryId })
          .from(reviews)
          .where(eq(reviews.entryId, entryId))
          .limit(1);
        if (existing[0]) {
          return c.json({ enrolled: 0, skipped: 1 });
        }
        await deps.db
          .insert(reviews)
          .values({
            entryId,
            state: fresh.state,
            dueAt: fresh.dueAt,
            intervalDays: fresh.intervalDays,
            ease: fresh.ease,
            lapses: fresh.lapses,
          })
          .onConflictDoNothing();
        return c.json({ enrolled: 1, skipped: 0 });
      }

      // `all: true` — backfill every ready entry that has no card yet. Failed and
      // still-pending entries are skipped: they have no takeaway to reveal.
      const candidates = await deps.db
        .select({ id: entries.id })
        .from(entries)
        .leftJoin(reviews, eq(reviews.entryId, entries.id))
        .where(and(eq(entries.status, "ready"), isNull(reviews.entryId)));

      for (let i = 0; i < candidates.length; i += ENROLL_CHUNK) {
        const chunk = candidates.slice(i, i + ENROLL_CHUNK);
        await deps.db
          .insert(reviews)
          .values(
            chunk.map((row) => ({
              entryId: row.id,
              state: fresh.state,
              dueAt: fresh.dueAt,
              intervalDays: fresh.intervalDays,
              ease: fresh.ease,
              lapses: fresh.lapses,
            })),
          )
          .onConflictDoNothing();
      }

      const readyRows = await deps.db
        .select({ n: count() })
        .from(entries)
        .where(eq(entries.status, "ready"));
      const ready = Number(readyRows[0]?.n ?? 0);
      return c.json({
        enrolled: candidates.length,
        skipped: Math.max(0, ready - candidates.length),
      });
    },
  );

  router.post(
    "/:entryId",
    zValidator("json", gradeReviewSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: grade must be an integer 1-4.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const entryId = c.req.param("entryId");
      const { grade } = c.req.valid("json");
      // Narrows what zod already checked, so the scheduler is never handed a
      // number outside 1-4 through some future call path that skips validation.
      if (!isReviewGrade(grade)) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: grade must be an integer 1-4.",
        );
      }

      const rows = await deps.db
        .select()
        .from(reviews)
        .where(eq(reviews.entryId, entryId))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new HttpError(
          404,
          "not_found",
          "That entry is not in your review queue.",
        );
      }

      const next = scheduleReview(
        {
          state: normalizeReviewState(row.state),
          intervalDays: row.intervalDays,
          ease: row.ease,
          lapses: row.lapses,
        },
        grade,
        deps.now(),
      );

      await deps.db
        .update(reviews)
        .set({
          state: next.state,
          dueAt: next.dueAt,
          intervalDays: next.intervalDays,
          ease: next.ease,
          lapses: next.lapses,
          lastGrade: next.lastGrade,
          reviewedAt: next.reviewedAt,
        })
        .where(eq(reviews.entryId, entryId));

      return c.json(toReviewScheduleDTO({ entryId, ...next }));
    },
  );

  return router;
}
