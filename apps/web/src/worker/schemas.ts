import { z } from "zod";
import {
  MAX_MAX_ITEMS,
  MAX_WINDOW_DAYS,
  MIN_MAX_ITEMS,
  MIN_WINDOW_DAYS,
} from "./digest.js";

export const createEntrySchema = z.object({
  url: z.string().min(1),
});

export const runDigestSchema = z.object({
  windowDays: z
    .number()
    .int()
    .min(MIN_WINDOW_DAYS)
    .max(MAX_WINDOW_DAYS)
    .optional(),
  maxItems: z.number().int().min(MIN_MAX_ITEMS).max(MAX_MAX_ITEMS).optional(),
});

export const settingsSchema = z.object({
  provider: z.enum(["openai", "anthropic", "groq"]),
  model: z.string().min(1),
  // WHY: omittable so a save can keep the stored key — the route enforces that it
  // may only be omitted when provider/cfAccountId/cfGatewayId are unchanged.
  apiKey: z.string().min(1).optional(),
  cfAccountId: z.string().min(1),
  cfGatewayId: z.string().min(1),
  // WHY: "" is meaningful here (clear the stored gateway token), so no min(1).
  cfAigToken: z.string().optional(),
});

export const createFeedSchema = z.object({
  url: z.string().min(1),
});

export const updateFeedSchema = z.object({
  enabled: z.boolean(),
});

export const gradeReviewSchema = z.object({
  grade: z.number().int().min(1).max(4),
});

// WHY: exactly one of the two shapes — `{entryId}` enrolls one card, `{all: true}`
// backfills the whole library, and sending both (or neither) is a client bug worth
// a 422 rather than a silent guess about which one was meant.
export const enrollReviewSchema = z
  .object({
    entryId: z.string().min(1).optional(),
    all: z.literal(true).optional(),
  })
  .refine((v) => (v.entryId === undefined) !== (v.all === undefined), {
    message: "Provide exactly one of entryId or all: true.",
  });

// WHY so permissive: this is an append-only signal log, so the only thing worth
// rejecting is a body that would make a row meaningless. `kind` is the one
// required field; every reference is optional because a vote may be about a chat
// turn, an entry, or neither. The comment cap is the single guard against the
// log being used as blob storage — it is not a validation of content.
export const MAX_FEEDBACK_COMMENT = 2000;

export const createFeedbackSchema = z.object({
  kind: z.enum(["up", "down"]),
  conversationId: z.string().min(1).optional(),
  messageId: z.string().min(1).optional(),
  entryId: z.string().min(1).optional(),
  comment: z.string().min(1).max(MAX_FEEDBACK_COMMENT).optional(),
});

export type CreateFeedbackBody = z.infer<typeof createFeedbackSchema>;

export type CreateEntryBody = z.infer<typeof createEntrySchema>;
export type CreateFeedBody = z.infer<typeof createFeedSchema>;
export type UpdateFeedBody = z.infer<typeof updateFeedSchema>;
export type GradeReviewBody = z.infer<typeof gradeReviewSchema>;
export type EnrollReviewBody = z.infer<typeof enrollReviewSchema>;
export type SettingsBody = z.infer<typeof settingsSchema>;
export type RunDigestBody = z.infer<typeof runDigestSchema>;
