import { entries, settings as settingsTable } from "@til/db";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import { toLLMSettings } from "./settings.js";

const EMBED_MODEL = "bge-m3";

export async function ingestEntry(deps: Deps, entryId: string): Promise<void> {
  const beforeRows = await deps.db
    .select()
    .from(entries)
    .where(eq(entries.id, entryId));
  const entry = beforeRows[0];
  if (!entry) return;

  try {
    const { html, finalUrl } = await deps.fetchPage(entry.url, deps.fetchImpl);
    const { markdown, title } = await deps.extractor.toMarkdown(html, finalUrl);

    const settingsRows = await deps.db.select().from(settingsTable).limit(1);
    const settingsRow = settingsRows[0];
    if (!settingsRow) {
      throw new Error("settings not configured");
    }

    const llm = deps.llmFactory(toLLMSettings(settingsRow));
    const digest = await llm.digest(markdown, { url: finalUrl, title });

    const now = deps.now();
    await deps.db
      .update(entries)
      .set({
        title: digest.title,
        contentMarkdown: markdown,
        summary: digest.summary,
        takeaway: digest.takeaway,
        question: digest.question,
        tags: JSON.stringify(digest.tags),
        status: "ready",
        error: null,
        updatedAt: now,
      })
      .where(eq(entries.id, entryId));

    if (deps.vectorize) {
      try {
        const vec = await deps.embed({
          title: digest.title,
          summary: digest.summary,
          takeaway: digest.takeaway,
          tags: digest.tags,
        });
        if (vec) {
          await deps.vectorize.upsert([
            {
              id: entryId,
              values: vec,
              metadata: {
                domain: entry.sourceDomain ?? "",
                createdAt: entry.createdAt,
                embedModel: EMBED_MODEL,
              },
            },
          ]);
        }
      } catch (err) {
        console.warn(
          `[ingest ${entryId}] vectorize upsert failed (non-fatal):`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest ${entryId}] failed:`, message);
    await deps.db
      .update(entries)
      .set({ status: "failed", error: message, updatedAt: deps.now() })
      .where(eq(entries.id, entryId));
  }
}
