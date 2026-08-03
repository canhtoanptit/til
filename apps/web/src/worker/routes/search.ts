import { Hono } from "hono";
import { sql } from "drizzle-orm";
import type { Entry } from "@til/db";
import type { AppContextEnv } from "../deps.js";
import { sanitizeFtsQuery } from "../search.js";
import { toEntryDTO } from "../dto.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function createSearchRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const url = new URL(c.req.url);
    const q = url.searchParams.get("q") ?? "";
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
    );

    const clean = sanitizeFtsQuery(q);
    if (!clean) {
      return c.json({ items: [] });
    }

    const rows = await deps.db.all<Entry>(
      sql`
        SELECT e.* FROM entries e
        JOIN entries_fts f ON f.rowid = e.rowid
        WHERE entries_fts MATCH ${clean}
        ORDER BY rank
        LIMIT ${limit}
      `,
    );

    return c.json({ items: rows.map(toEntryDTO) });
  });

  return router;
}
