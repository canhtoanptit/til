import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { settings as settingsTable } from "@til/db";
import { eq } from "drizzle-orm";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import { settingsSchema } from "../schemas.js";
import { toLLMSettings, toSettingsDTO } from "../settings.js";

export function createSettingsRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const rows = await deps.db.select().from(settingsTable).limit(1);
    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "not_found", "Settings not configured.");
    }
    return c.json(toSettingsDTO(row));
  });

  router.put(
    "/",
    zValidator("json", settingsSchema, (result) => {
      if (!result.success) {
        throw new HttpError(
          422,
          "validation_error",
          "Invalid settings body — provider, model, apiKey, cfAccountId, cfGatewayId are required.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const body = c.req.valid("json");
      const now = deps.now();

      const existing = await deps.db
        .select({ id: settingsTable.id })
        .from(settingsTable)
        .limit(1);

      if (existing[0]) {
        await deps.db
          .update(settingsTable)
          .set({
            provider: body.provider,
            model: body.model,
            apiKey: body.apiKey,
            cfAccountId: body.cfAccountId,
            cfGatewayId: body.cfGatewayId,
            cfAigToken: body.cfAigToken ?? null,
            updatedAt: now,
          })
          .where(eq(settingsTable.id, existing[0].id));
      } else {
        await deps.db.insert(settingsTable).values({
          id: 1,
          provider: body.provider,
          model: body.model,
          apiKey: body.apiKey,
          cfAccountId: body.cfAccountId,
          cfGatewayId: body.cfGatewayId,
          cfAigToken: body.cfAigToken ?? null,
          createdAt: now,
          updatedAt: now,
        });
      }

      const rows = await deps.db.select().from(settingsTable).limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error("Settings row missing after upsert.");
      }
      return c.json(toSettingsDTO(row));
    },
  );

  router.post("/test", async (c) => {
    const deps = c.get("deps");
    const rows = await deps.db.select().from(settingsTable).limit(1);
    const row = rows[0];
    if (!row) {
      throw new HttpError(404, "not_found", "Settings not configured.");
    }
    const client = deps.llmFactory(toLLMSettings(row));
    const result = await client.ping();
    return c.json(result);
  });

  return router;
}
