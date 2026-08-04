import { entries, entryVectors } from "@til/db";
import { and, asc, eq } from "drizzle-orm";
import { embeddingTextFor } from "@til/core";
import type { Deps } from "./deps.js";
import { parseTags } from "./dto.js";

export const REEMBED_BATCH_SIZE = 16;
export const REEMBED_MAX_ENTRIES = 200;

export interface IndexableEntry {
  id: string;
  title: string | null;
  summary: string | null;
  takeaway: string | null;
  tags: string[];
  sourceDomain: string | null;
  createdAt: number;
}

export interface ReembedResult {
  embedded: number;
  skipped: number;
  failed: number;
}

/**
 * Embeds one entry and upserts its vector. Never throws: indexing is best-effort
 * so a missing embedder (Ollama down, no AI binding) cannot fail an ingest.
 * Returns false when nothing was indexed.
 */
export async function indexEntry(
  deps: Deps,
  entry: IndexableEntry,
): Promise<boolean> {
  const { embedder, vectorStore } = deps;
  if (!embedder || !vectorStore) return false;
  const text = embeddingTextFor(entry);
  if (text.trim().length === 0) return false;

  try {
    const [values] = await embedder.embed([text]);
    if (!values) throw new Error("embedder returned no vector");
    await vectorStore.upsert([
      {
        id: entry.id,
        values,
        metadata: {
          domain: entry.sourceDomain ?? "",
          createdAt: entry.createdAt,
          embedModel: embedder.model,
        },
      },
    ]);
    return true;
  } catch (err) {
    console.warn(
      `[index ${entry.id}] embedding failed (non-fatal, entry stays unindexed):`,
      describeError(err),
    );
    return false;
  }
}

/** Backfills vectors for `ready` entries that have none, or a stale one. */
export async function reembedEntries(
  deps: Deps,
  opts: { limit?: number } = {},
): Promise<ReembedResult> {
  const { embedder, vectorStore } = deps;
  const limit = Math.min(
    REEMBED_MAX_ENTRIES,
    Math.max(1, opts.limit ?? REEMBED_MAX_ENTRIES),
  );

  const rows = await deps.db
    .select({
      id: entries.id,
      title: entries.title,
      summary: entries.summary,
      takeaway: entries.takeaway,
      tags: entries.tags,
      sourceDomain: entries.sourceDomain,
      createdAt: entries.createdAt,
      updatedAt: entries.updatedAt,
    })
    .from(entries)
    .where(eq(entries.status, "ready"))
    .orderBy(asc(entries.createdAt))
    .limit(limit);

  if (!embedder || !vectorStore) {
    return { embedded: 0, skipped: rows.length, failed: 0 };
  }

  // WHY: `entry_vectors` is the local store's table, so in `cloud` mode it is
  // empty and every entry looks unindexed. Re-embedding is idempotent (upsert by
  // id), so the cost of that is duplicated work, never a wrong result.
  const indexed = await loadFreshVectorIds(deps, embedder);

  const pending: IndexableEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    const vector = indexed.get(row.id);
    if (vector !== undefined && vector >= row.updatedAt) {
      skipped += 1;
      continue;
    }
    const entry: IndexableEntry = {
      id: row.id,
      title: row.title ?? null,
      summary: row.summary ?? null,
      takeaway: row.takeaway ?? null,
      tags: parseTags(row.tags),
      sourceDomain: row.sourceDomain ?? null,
      createdAt: row.createdAt,
    };
    if (embeddingTextFor(entry).trim().length === 0) {
      skipped += 1;
      continue;
    }
    pending.push(entry);
  }

  let embedded = 0;
  let failed = 0;
  for (let i = 0; i < pending.length; i += REEMBED_BATCH_SIZE) {
    const batch = pending.slice(i, i + REEMBED_BATCH_SIZE);
    try {
      const vectors = await embedder.embed(
        batch.map((entry) => embeddingTextFor(entry)),
      );
      const records = [];
      for (let j = 0; j < batch.length; j += 1) {
        const entry = batch[j];
        const values = vectors[j];
        if (!entry || !values) {
          failed += 1;
          continue;
        }
        records.push({
          id: entry.id,
          values,
          metadata: {
            domain: entry.sourceDomain ?? "",
            createdAt: entry.createdAt,
            embedModel: embedder.model,
          },
        });
      }
      await vectorStore.upsert(records);
      embedded += records.length;
    } catch (err) {
      failed += batch.length;
      console.warn(
        `[reembed] batch of ${batch.length} failed:`,
        describeError(err),
      );
    }
  }

  return { embedded, skipped, failed };
}

/** entryId → vector createdAt, for vectors matching the current embedder. */
async function loadFreshVectorIds(
  deps: Deps,
  embedder: NonNullable<Deps["embedder"]>,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const rows = await deps.db
      .select({
        entryId: entryVectors.entryId,
        createdAt: entryVectors.createdAt,
      })
      .from(entryVectors)
      .where(
        and(
          eq(entryVectors.embedModel, embedder.model),
          eq(entryVectors.dims, embedder.dimensions),
        ),
      );
    for (const row of rows) out.set(row.entryId, row.createdAt);
  } catch (err) {
    console.warn("[reembed] could not read entry_vectors:", describeError(err));
  }
  return out;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
