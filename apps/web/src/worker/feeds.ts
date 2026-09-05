import { and, asc, eq } from "drizzle-orm";
import { feeds } from "@til/db";
import type { Deps } from "./deps.js";

/**
 * The digest's RSS source list. Enabled rows only, ordered by insertion so a run
 * is reproducible; core's `DEFAULT_RSS_FEEDS` is now only what migration 0005
 * seeded into this table.
 */
export async function listEnabledFeedUrls(
  db: Deps["db"],
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ url: feeds.url })
    .from(feeds)
    .where(and(eq(feeds.userId, userId), eq(feeds.enabled, true)))
    .orderBy(asc(feeds.createdAt), asc(feeds.id));
  return rows.map((row) => row.url);
}
