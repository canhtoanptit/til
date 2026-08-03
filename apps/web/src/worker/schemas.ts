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

export type CreateEntryBody = z.infer<typeof createEntrySchema>;
export type SettingsBody = z.infer<typeof settingsSchema>;
export type RunDigestBody = z.infer<typeof runDigestSchema>;
