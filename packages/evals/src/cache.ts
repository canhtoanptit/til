import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Embedder } from "@til/core";
import { EMBEDDING_CACHE_DIR } from "./datasets.js";

/** Texts per REST call. bge-m3 accepts a batch; this bounds the payload size. */
export const EMBED_BATCH_SIZE = 25;

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  requests: number;
}

export interface EmbeddingCache {
  /** Embeds `texts`, calling the embedder only for texts it has not seen. */
  embed(texts: string[]): Promise<number[][]>;
  stats(): EmbeddingCacheStats;
  save(): void;
  path: string;
}

/**
 * Disk cache for corpus and query embeddings, keyed by model plus a hash of the
 * text. Re-running the suite after editing one entry then costs one REST call
 * instead of fifty, which is the difference between a harness somebody runs and
 * one they avoid.
 */
export function createEmbeddingCache(
  embedder: Embedder,
  opts: { dir?: string; batchSize?: number } = {},
): EmbeddingCache {
  const dir = opts.dir ?? EMBEDDING_CACHE_DIR;
  const batchSize = Math.max(1, opts.batchSize ?? EMBED_BATCH_SIZE);
  const path = join(dir, `embeddings-${safeName(embedder.model)}.json`);
  const store = readStore(path);
  let hits = 0;
  let misses = 0;
  let requests = 0;
  let dirty = false;

  const embed = async (texts: string[]): Promise<number[][]> => {
    const keys = texts.map((text) => keyFor(embedder, text));
    const pending: { index: number; text: string; key: string }[] = [];
    const out: (number[] | undefined)[] = texts.map((text, index) => {
      const key = keys[index] ?? "";
      const cached = store.get(key);
      if (cached !== undefined) {
        hits += 1;
        return cached;
      }
      // Two identical texts in one batch must not be embedded twice.
      if (!pending.some((item) => item.key === key)) {
        pending.push({ index, text, key });
      }
      misses += 1;
      return undefined;
    });

    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await embedder.embed(batch.map((item) => item.text));
      requests += 1;
      if (vectors.length !== batch.length) {
        throw new Error(
          `embedding cache: asked for ${batch.length} vectors, got ${vectors.length}`,
        );
      }
      for (let j = 0; j < batch.length; j += 1) {
        const item = batch[j];
        const vector = vectors[j];
        if (item === undefined || vector === undefined) continue;
        store.set(item.key, vector);
        dirty = true;
      }
    }

    return out.map((vector, index) => {
      if (vector !== undefined) return vector;
      const resolved = store.get(keys[index] ?? "");
      if (resolved === undefined) {
        throw new Error(`embedding cache: no vector for text #${index}`);
      }
      return resolved;
    });
  };

  const save = (): void => {
    if (!dirty) return;
    mkdirSync(dir, { recursive: true });
    const body: Record<string, number[]> = {};
    for (const [key, vector] of store) body[key] = vector;
    // Write-then-rename so an interrupted run cannot leave a truncated cache.
    const temp = `${path}.tmp`;
    writeFileSync(temp, JSON.stringify(body), "utf8");
    renameSync(temp, path);
    dirty = false;
  };

  return {
    embed,
    save,
    path,
    stats: () => ({ hits, misses, requests }),
  };
}

function keyFor(embedder: Embedder, text: string): string {
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return `${embedder.model}:${embedder.dimensions}:${digest.slice(0, 32)}`;
}

function readStore(path: string): Map<string, number[]> {
  const store = new Map<string, number[]>();
  if (!existsSync(path)) return store;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // A corrupt cache is not worth failing a run over; re-embed instead.
    return store;
  }
  if (typeof parsed !== "object" || parsed === null) return store;
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (!Array.isArray(value)) continue;
    const vector: number[] = [];
    let ok = true;
    for (const item of value) {
      if (typeof item !== "number" || !Number.isFinite(item)) {
        ok = false;
        break;
      }
      vector.push(item);
    }
    if (ok) store.set(key, vector);
  }
  return store;
}

function safeName(model: string): string {
  return model.replace(/[^a-zA-Z0-9._-]+/g, "_");
}
