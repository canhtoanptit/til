import { Hono } from "hono";
import { CHAT_SEARCH_MAX_TOP_K } from "@til/core";
import type { AppContextEnv } from "../deps.js";
import { searchEntryRows } from "../retrieval.js";
import { toEntryDTO } from "../dto.js";

const DEFAULT_LIMIT = 20;

export function createSearchRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    const url = new URL(c.req.url);
    const q = url.searchParams.get("q") ?? "";
    if (q.trim().length === 0) {
      return c.json({ items: [] });
    }

    // WHY: the hybrid path is bounded by the chat tool's ceiling — the old
    // limit=100 would mean embedding work for results nobody scrolls to.
    const limitRaw = Number(url.searchParams.get("limit") ?? DEFAULT_LIMIT);
    const limit = Math.min(
      CHAT_SEARCH_MAX_TOP_K,
      Math.max(1, Number.isFinite(limitRaw) ? limitRaw : DEFAULT_LIMIT),
    );

    const scored = await searchEntryRows(deps, { query: q, topK: limit });
    return c.json({ items: scored.map(({ row }) => toEntryDTO(row)) });
  });

  return router;
}
