import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { feedback } from "@til/db";
import type { AppContextEnv } from "../deps.js";
import { toFeedbackDTO } from "../dto.js";
import { HttpError } from "../http-error.js";
import { createFeedbackSchema } from "../schemas.js";

/**
 * POST /api/feedback — append one thumbs-up/down signal.
 *
 * Deliberately dumb: no dedupe, no upsert, no existence checks on the ids it is
 * handed. Every click is a fact that happened at a point in time, so a second
 * vote on the same message is a second row (a correction, in order), and a vote
 * about an entry that is later deleted stays in the log. Nothing reads this
 * table yet; it accumulates for the retrieval-quality work.
 */
export function createFeedbackRouter() {
  const router = new Hono<AppContextEnv>();

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
