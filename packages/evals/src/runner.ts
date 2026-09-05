import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import * as schema from "@til/db";
import { OWNER_USER_ID, entries, entryVectors } from "@til/db";
import { cosineSimilarity, embeddingTextFor } from "@til/core";
import type {
  VectorMatch,
  VectorQueryOptions,
  VectorRecord,
  VectorStore,
} from "@til/core";
import type { CorpusEntry } from "./datasets.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = resolve(packageRoot, "..", "db", "migrations");

/** Fixed clock so `createdAt`, week buckets and streaks are reproducible. */
export const EVAL_NOW = 1_786_000_000_000;

/**
 * The one tenant this benchmark has. Retrieval is a per-user query in the app
 * (migration 0012), so every seed, every vector and every query in this package
 * is pinned to a single user id — the suite measures ranking, not isolation.
 * It is `OWNER_USER_ID` on purpose: that is also the `user_id` SQL default, so
 * a row seeded through raw SQL agrees with one seeded through drizzle.
 */
export const EVAL_USER_ID = OWNER_USER_ID;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Spacing between fixture entries; 1.3 days spreads 50 entries over ~9 weeks. */
const SPACING_MS = Math.round(1.3 * DAY_MS);

export type EvalDb = BetterSQLite3Database<typeof schema>;

export interface EvalStack {
  db: EvalDb;
  sqlite: Database.Database;
  vectorStore: VectorStore;
  entryById: Map<string, CorpusEntry>;
  now: () => number;
  close(): void;
}

export interface BuildEvalStackOptions {
  corpus: CorpusEntry[];
  /** Usually the caching wrapper around `WorkersAIRestEmbedder`. */
  embed(texts: string[]): Promise<number[][]>;
  embedModel: string;
  dimensions: number;
  now?: number;
}

/**
 * A complete retrieval stack in memory: the real migrations (so FTS5 and its
 * triggers behave exactly as in production), the corpus seeded through the same
 * `entries` table, and one vector per entry embedded from `embeddingTextFor` —
 * the same composition the app indexes with.
 */
export async function buildEvalStack(
  opts: BuildEvalStackOptions,
): Promise<EvalStack> {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  applyMigrations(sqlite);
  const db = drizzle(sqlite, { schema });
  const baseNow = opts.now ?? EVAL_NOW;

  const entryById = new Map<string, CorpusEntry>();
  opts.corpus.forEach((entry, index) => {
    entryById.set(entry.id, entry);
    const createdAt = baseNow - index * SPACING_MS;
    db.insert(entries)
      .values({
        id: entry.id,
        userId: EVAL_USER_ID,
        url: entry.url,
        canonicalUrl: entry.url,
        title: entry.title,
        summary: entry.summary,
        takeaway: entry.takeaway,
        question: entry.question,
        sourceDomain: domainOf(entry.url),
        contentMarkdown: entry.contentMarkdown,
        tags: JSON.stringify(entry.tags),
        status: "ready",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  });

  const vectorStore = new SqliteVectorStore(db, opts.dimensions);
  const texts = opts.corpus.map((entry) => embeddingTextFor(entry));
  const vectors = await opts.embed(texts);
  if (vectors.length !== opts.corpus.length) {
    throw new Error(
      `runner: embedded ${vectors.length} texts for ${opts.corpus.length} entries`,
    );
  }
  const records: VectorRecord[] = [];
  opts.corpus.forEach((entry, index) => {
    const values = vectors[index];
    if (values === undefined) return;
    records.push({
      id: entry.id,
      userId: EVAL_USER_ID,
      values,
      metadata: {
        domain: domainOf(entry.url),
        createdAt: baseNow - index * SPACING_MS,
        embedModel: opts.embedModel,
      },
    });
  });
  await vectorStore.upsert(records);

  return {
    db,
    sqlite,
    vectorStore,
    entryById,
    now: () => baseNow,
    close: () => sqlite.close(),
  };
}

/** Adds one more entry after the stack is built — used by the injection suite. */
export async function seedExtraEntry(
  stack: EvalStack,
  entry: CorpusEntry,
  opts: { embed(texts: string[]): Promise<number[][]>; embedModel: string },
): Promise<void> {
  const createdAt = stack.now();
  stack.db
    .insert(entries)
    .values({
      id: entry.id,
      userId: EVAL_USER_ID,
      url: entry.url,
      canonicalUrl: entry.url,
      title: entry.title,
      summary: entry.summary,
      takeaway: entry.takeaway,
      question: entry.question,
      sourceDomain: domainOf(entry.url),
      contentMarkdown: entry.contentMarkdown,
      tags: JSON.stringify(entry.tags),
      status: "ready",
      createdAt,
      updatedAt: createdAt,
    })
    .run();
  stack.entryById.set(entry.id, entry);
  const [values] = await opts.embed([embeddingTextFor(entry)]);
  if (values === undefined) throw new Error("runner: no vector for seed entry");
  await stack.vectorStore.upsert([
    {
      id: entry.id,
      userId: EVAL_USER_ID,
      values,
      metadata: {
        domain: domainOf(entry.url),
        createdAt,
        embedModel: opts.embedModel,
      },
    },
  ]);
}

export function removeEntries(stack: EvalStack, ids: string[]): void {
  if (ids.length === 0) return;
  stack.db.delete(entries).where(inArray(entries.id, ids)).run();
  for (const id of ids) stack.entryById.delete(id);
}

/**
 * The eval-side twin of the app's `D1VectorStore`: vectors as JSON in
 * `entry_vectors`, scored by a linear cosine scan. Kept here because the app's
 * copy lives behind a worker entrypoint this package deliberately does not
 * depend on; if the scoring rule ever changes, both must change.
 */
export class SqliteVectorStore implements VectorStore {
  private readonly db: EvalDb;
  private readonly dimensions: number;

  constructor(db: EvalDb, dimensions: number) {
    this.db = db;
    this.dimensions = dimensions;
  }

  // `vector.userId` is deliberately dropped, exactly as D1VectorStore drops it:
  // `entry_vectors` has no user column, its scope lives on the parent `entries`
  // row (migration 0012) and is applied by the join in `query`.
  async upsert(vectors: VectorRecord[]): Promise<void> {
    for (const vector of vectors) {
      if (vector.values.length !== this.dimensions) {
        throw new Error(
          `SqliteVectorStore.upsert: vector has ${vector.values.length} dimensions, expected ${this.dimensions}`,
        );
      }
      this.db
        .insert(entryVectors)
        .values({
          entryId: vector.id,
          embedModel: vector.metadata.embedModel,
          dims: vector.values.length,
          values: JSON.stringify(vector.values),
          createdAt: vector.metadata.createdAt,
        })
        .onConflictDoUpdate({
          target: entryVectors.entryId,
          set: {
            embedModel: vector.metadata.embedModel,
            dims: vector.values.length,
            values: JSON.stringify(vector.values),
            createdAt: vector.metadata.createdAt,
          },
        })
        .run();
    }
  }

  async query(
    values: number[],
    opts: VectorQueryOptions,
  ): Promise<VectorMatch[]> {
    if (opts.topK <= 0) return [];
    // The same join D1VectorStore uses: scoping is part of the query semantics
    // this class is the twin of, so it belongs here even though the benchmark
    // only ever has one tenant (EVAL_USER_ID).
    const rows = this.db
      .select({
        entryId: entryVectors.entryId,
        dims: entryVectors.dims,
        values: entryVectors.values,
      })
      .from(entryVectors)
      .innerJoin(entries, eq(entries.id, entryVectors.entryId))
      .where(eq(entries.userId, opts.userId))
      .all();
    const scored: VectorMatch[] = [];
    for (const row of rows) {
      if (row.dims !== values.length) continue;
      const stored = JSON.parse(row.values) as number[];
      if (stored.length !== values.length) continue;
      scored.push({ id: row.entryId, score: cosineSimilarity(values, stored) });
    }
    scored.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
    return scored.slice(0, opts.topK);
  }

  async getVector(id: string): Promise<number[] | null> {
    const rows = this.db
      .select({ dims: entryVectors.dims, values: entryVectors.values })
      .from(entryVectors)
      .where(eq(entryVectors.entryId, id))
      .limit(1)
      .all();
    const row = rows[0];
    if (!row || row.dims !== this.dimensions) return null;
    const values = JSON.parse(row.values) as number[];
    return values.length === this.dimensions ? values : null;
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    this.db
      .delete(entryVectors)
      .where(inArray(entryVectors.entryId, ids))
      .run();
  }
}

function applyMigrations(sqlite: Database.Database): void {
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  if (files.length === 0) {
    throw new Error(`runner: no migrations found in ${migrationsDir}`);
  }
  for (const file of files) {
    sqlite.exec(readFileSync(join(migrationsDir, file), "utf8"));
  }
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
