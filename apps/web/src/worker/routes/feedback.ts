import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { zValidator } from "@hono/zod-validator";
import { feedback } from "@til/db";
import type { AppContextEnv } from "../deps.js";
import { toFeedbackDTO } from "../dto.js";
import { HttpError } from "../http-error.js";
import { createFeedbackSchema } from "../schemas.js";

/**
 * How many rows one conversation's read can return. A vote needs a message to be
 * about, so this is bounded by the transcript length in practice; the cap only
 * exists so a pathological log cannot become the chat page's payload.
 */
export const MAX_FEEDBACK_ROWS = 200;

/**
 * POST /api/feedback — append one thumbs-up/down signal.
 *
 * Deliberately dumb: no dedupe, no upsert, no existence checks on the ids it is
 * handed. Every click is a fact that happened at a point in time, so a second
 * vote on the same message is a second row (a correction, in order), and a vote
 * about an entry that is later deleted stays in the log.
 *
 * GET /api/feedback?conversationId=… — read one conversation's votes back, which
 * is what lets a reloaded chat page light the thumbs it has already recorded.
 */
export function createFeedbackRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const url = new URL(c.req.url);
    const conversationId = (
      url.searchParams.get("conversationId") ?? ""
    ).trim();
    // WHY required rather than "omit to list everything": the only reader is one
    // conversation's chat page, and an unscoped dump of the whole signal log is
    // both useless to it and the kind of endpoint that quietly grows unbounded.
    if (conversationId.length === 0) {
      throw new HttpError(
        422,
        "validation_error",
        "Query parameter conversationId is required.",
      );
    }

    // Read newest-first under the cap and reverse, rather than taking the oldest
    // N: a truncated log must keep the most recent votes, because those are the
    // corrections that decide what the thumbs show.
    const rows = await deps.db
      .select()
      .from(feedback)
      .where(eq(feedback.conversationId, conversationId))
      // The id tiebreak matters: two votes in the same millisecond must come back
      // in one fixed order, or "the latest one" is a coin toss.
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(MAX_FEEDBACK_ROWS);

    return c.json({ items: rows.reverse().map(toFeedbackDTO) });
  });

  router.post(
    "/",
    zValidator("json", createFeedbackSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid request body: kind must be 'up' or 'down'.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const body = c.req.valid("json");
      const row = {
        id: crypto.randomUUID(),
        conversationId: body.conversationId ?? null,
        messageId: body.messageId ?? null,
        entryId: body.entryId ?? null,
        kind: body.kind,
        comment: body.comment ?? null,
        createdAt: deps.now(),
      };
      await deps.db.insert(feedback).values(row);
      // The table has no server-side defaults, so the row we inserted and the row
      // in D1 cannot differ — no read-back needed to answer honestly.
      return c.json(toFeedbackDTO(row), 201);
    },
  );

  return router;
}
