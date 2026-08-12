import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { entries } from "@til/db";
import type { AppContextEnv } from "../deps.js";
import type { Deps } from "../deps.js";
import { parseTags, type TagCountDTO } from "../dto.js";

/**
 * Every tag in the library with how many entries carry it, most-used first and
 * alphabetical within a tie.
 *
 * Two decisions worth stating out loud:
 *
 * 1. Archived entries are excluded from the counts. `GET /api/tags` exists to feed
 *    the /tags browse page, and every count there is a link to
 *    `/tags/:tag` — which lists the default (non-archived) view. Counting archived
 *    rows would print "12" next to a link that shows 3. A tag carried only by
 *    archived entries therefore disappears from the list entirely, which is the
 *    same thing archiving does everywhere else in the app.
 *
 * 2. The grouping is TypeScript over the JSON column, not `json_each`. `parseTags`
 *    is already the single definition of how that column is read, so a count here
 *    cannot drift from the `tags` array the entry endpoints return, and it needs
 *    neither JSON1 nor the correlated subquery whose unqualified raw-column
 *    rendering bit us in M2. At one row per saved article this is a single scan of
 *    one narrow column.
 *
 * Deliberately uncapped, unlike the chat `top_tags` aggregate: this is a browse
 * page, and truncating it would silently hide tags the owner is looking for.
 */
export async function tagCountRows(deps: Deps): Promise<TagCountDTO[]> {
  const rows = await deps.db
    .select({ tags: entries.tags })
    .from(entries)
    .where(eq(entries.archived, false));

  const counts = new Map<string, number>();
  for (const row of rows) {
    for (const tag of parseTags(row.tags)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  const out: TagCountDTO[] = [];
  for (const [tag, count] of counts) out.push({ tag, count });
  out.sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  return out;
}

export function createTagsRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/", async (c) => {
    const deps = c.get("deps");
    return c.json({ items: await tagCountRows(deps) });
  });

  return router;
}
