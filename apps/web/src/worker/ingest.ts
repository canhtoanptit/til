import { entries, settings as settingsTable } from "@til/db";
import { eq } from "drizzle-orm";
import type { Deps } from "./deps.js";
import { indexEntry } from "./indexing.js";
import { toLLMSettings } from "./settings.js";

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

    // WHY: indexing is deliberately after the `ready` write and never throws —
    // an unindexed entry is a search gap, not a failed capture (ADR-0010).
    await indexEntry(deps, {
      id: entryId,
      title: digest.title,
      summary: digest.summary,
      takeaway: digest.takeaway,
      tags: digest.tags,
      sourceDomain: entry.sourceDomain ?? null,
      createdAt: entry.createdAt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[ingest ${entryId}] failed:`, message);
    await deps.db
      .update(entries)
      .set({ status: "failed", error: message, updatedAt: deps.now() })
      .where(eq(entries.id, entryId));
  }
}
