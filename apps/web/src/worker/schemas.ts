import { z } from "zod";

export const createEntrySchema = z.object({
  url: z.string().min(1),
});

export const settingsSchema = z.object({
  provider: z.enum(["openai", "anthropic"]),
  model: z.string().min(1),
  apiKey: z.string().min(1),
  cfAccountId: z.string().min(1),
  cfGatewayId: z.string().min(1),
  cfAigToken: z.string().min(1).optional(),
});

export type CreateEntryBody = z.infer<typeof createEntrySchema>;
export type SettingsBody = z.infer<typeof settingsSchema>;
