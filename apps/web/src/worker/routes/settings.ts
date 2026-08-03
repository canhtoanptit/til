import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { settings as settingsTable } from "@til/db";
import { eq } from "drizzle-orm";
import type { AppContextEnv } from "../deps.js";
import { HttpError } from "../http-error.js";
import { settingsSchema, type SettingsBody } from "../schemas.js";
import { toLLMSettings, toSettingsDTO } from "../settings.js";

interface StoredRouting {
  provider: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
}

// WHY (ADR-0007 v2): the key is never readable through the API, so it may be kept
// across a save only while the provider/gateway it is sent to stays identical —
// otherwise a caller holding the app token could repoint routing and exfiltrate it.
function resolveApiKey(
  body: SettingsBody,
  stored: StoredRouting | undefined,
): string {
  if (body.apiKey !== undefined) return body.apiKey;
  if (!stored) {
    throw new HttpError(
      422,
      "validation_error",
      "apiKey is required — no settings are saved yet, so the provider API key must be supplied.",
    );
  }
  const routingUnchanged =
    stored.provider === body.provider &&
    stored.cfAccountId === body.cfAccountId &&
    stored.cfGatewayId === body.cfGatewayId;
  if (!routingUnchanged) {
    throw new HttpError(
      422,
      "validation_error",
      "apiKey is required — provider, cfAccountId or cfGatewayId changed, so the key must be re-entered because gateway routing changed.",
    );
  }
  return stored.apiKey;
}

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
          "Invalid settings body — provider, model, cfAccountId, cfGatewayId are required; apiKey, when present, must be non-empty.",
        );
      }
    }),
    async (c) => {
      const deps = c.get("deps");
      const body = c.req.valid("json");
      const now = deps.now();

      const existing = await deps.db
        .select({
          id: settingsTable.id,
          provider: settingsTable.provider,
          apiKey: settingsTable.apiKey,
          cfAccountId: settingsTable.cfAccountId,
          cfGatewayId: settingsTable.cfGatewayId,
          cfAigToken: settingsTable.cfAigToken,
        })
        .from(settingsTable)
        .limit(1);

      const stored = existing[0];
      const apiKey = resolveApiKey(body, stored);
      // WHY: absent → keep the stored token; explicit "" → clear it.
      const cfAigToken =
        body.cfAigToken === undefined
          ? (stored?.cfAigToken ?? null)
          : body.cfAigToken === ""
            ? null
            : body.cfAigToken;

      if (stored) {
        await deps.db
          .update(settingsTable)
          .set({
            provider: body.provider,
            model: body.model,
            apiKey,
            cfAccountId: body.cfAccountId,
            cfGatewayId: body.cfGatewayId,
            cfAigToken,
            updatedAt: now,
          })
          .where(eq(settingsTable.id, stored.id));
      } else {
        await deps.db.insert(settingsTable).values({
          id: 1,
          provider: body.provider,
          model: body.model,
          apiKey,
          cfAccountId: body.cfAccountId,
          cfGatewayId: body.cfGatewayId,
          cfAigToken,
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
