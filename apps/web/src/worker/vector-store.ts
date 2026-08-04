import { entryVectors } from "@til/db";
import type { Db } from "@til/db";
import { inArray } from "drizzle-orm";
import { cosineSimilarity } from "@til/core";
import type { VectorMatch, VectorRecord, VectorStore } from "@til/core";

interface VectorizeMatch {
  id: string;
  score: number;
}

interface VectorizeMatches {
  matches?: VectorizeMatch[] | null;
}

export interface VectorizeIndexLike {
  upsert(
    vectors: { id: string; values: number[]; metadata?: unknown }[],
  ): Promise<unknown>;
  query(
    values: number[],
    opts?: { topK?: number; returnValues?: boolean; returnMetadata?: unknown },
  ): Promise<VectorizeMatches>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

function assertDims(label: string, values: number[], dimensions: number): void {
  if (values.length !== dimensions) {
    throw new Error(
      `${label}: vector has ${values.length} dimensions, index expects ${dimensions}.`,
    );
  }
}

/** Cloudflare Vectorize index `til-entries`; used in `TIL_STACK=cloud`. */
export class VectorizeStore implements VectorStore {
  private readonly index: VectorizeIndexLike;
  private readonly dimensions: number;

  constructor(index: VectorizeIndexLike, dimensions: number) {
    this.index = index;
    this.dimensions = dimensions;
  }

  async upsert(vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return;
    for (const vector of vectors) {
      assertDims("VectorizeStore.upsert", vector.values, this.dimensions);
    }
    await this.index.upsert(
      vectors.map((vector) => ({
        id: vector.id,
        values: vector.values,
        metadata: { ...vector.metadata },
      })),
    );
  }

  async query(
    values: number[],
    opts: { topK: number },
  ): Promise<VectorMatch[]> {
    assertDims("VectorizeStore.query", values, this.dimensions);
    const result = await this.index.query(values, { topK: opts.topK });
    const matches = result?.matches ?? [];
    const out: VectorMatch[] = [];
    for (const match of matches) {
      if (typeof match?.id !== "string") continue;
      out.push({
        id: match.id,
        score: typeof match.score === "number" ? match.score : 0,
      });
    }
    return out;
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.index.deleteByIds(ids);
  }
}

/**
 * Vectors in the D1 `entry_vectors` table; used in `TIL_STACK=local`, where
 * Vectorize has no emulator.
 */
export class D1VectorStore implements VectorStore {
  private readonly db: Db;
  private readonly dimensions: number;
  private readonly now: () => number;

  constructor(db: Db, dimensions: number, now: () => number = Date.now) {
    this.db = db;
    this.dimensions = dimensions;
    this.now = now;
  }

  async upsert(vectors: VectorRecord[]): Promise<void> {
    if (vectors.length === 0) return;
    for (const vector of vectors) {
      assertDims("D1VectorStore.upsert", vector.values, this.dimensions);
    }
    const createdAt = this.now();
    for (const vector of vectors) {
      const row = {
        entryId: vector.id,
        embedModel: vector.metadata.embedModel,
        dims: vector.values.length,
        values: JSON.stringify(vector.values),
        createdAt,
      };
      await this.db
        .insert(entryVectors)
        .values(row)
        .onConflictDoUpdate({
          target: entryVectors.entryId,
          set: {
            embedModel: row.embedModel,
            dims: row.dims,
            values: row.values,
            createdAt: row.createdAt,
          },
        });
    }
  }

  // WHY: deliberately O(n) — every vector is loaded and scored in TS. D1 cannot
  // load sqlite-vec, and at the single-user corpus size this targets (~10^3
  // entries) a linear scan costs milliseconds. This is a dev/small-corpus
  // implementation, not a scaling path; `cloud` mode uses Vectorize instead.
  async query(
    values: number[],
    opts: { topK: number },
  ): Promise<VectorMatch[]> {
    assertDims("D1VectorStore.query", values, this.dimensions);
    if (opts.topK <= 0) return [];

    const rows = await this.db
      .select({
        entryId: entryVectors.entryId,
        dims: entryVectors.dims,
        values: entryVectors.values,
      })
      .from(entryVectors);

    let mismatched = 0;
    const scored: VectorMatch[] = [];
    for (const row of rows) {
      if (row.dims !== values.length) {
        mismatched += 1;
        continue;
      }
      const stored = parseVector(row.values);
      if (stored === null || stored.length !== values.length) {
        mismatched += 1;
        continue;
      }
      scored.push({ id: row.entryId, score: cosineSimilarity(values, stored) });
    }
    if (mismatched > 0) {
      console.warn(
        `[D1VectorStore] skipped ${mismatched} vector(s) whose dimensions differ from the ${values.length}-d query — re-embed to make them searchable.`,
      );
    }

    scored.sort((a, b) => b.score - a.score || compareText(a.id, b.id));
    return scored.slice(0, opts.topK);
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .delete(entryVectors)
      .where(inArray(entryVectors.entryId, ids));
  }
}

export function isVectorizeIndexLike(
  index: unknown,
): index is VectorizeIndexLike {
  if (typeof index !== "object" || index === null) return false;
  const candidate = index as VectorizeIndexLike;
  return (
    typeof candidate.upsert === "function" &&
    typeof candidate.query === "function" &&
    typeof candidate.deleteByIds === "function"
  );
}

function parseVector(raw: string): number[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const out: number[] = [];
  for (const value of parsed) {
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    out.push(value);
  }
  return out;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
