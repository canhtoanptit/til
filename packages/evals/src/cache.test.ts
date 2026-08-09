import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Embedder } from "@til/core";
import { createEmbeddingCache } from "./cache.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "til-evals-cache-"));
}

interface Recording {
  embedder: Embedder;
  batches: string[][];
}

function recordingEmbedder(dimensions = 4, model = "bge-m3"): Recording {
  const batches: string[][] = [];
  return {
    batches,
    embedder: {
      model,
      dimensions,
      embed: async (texts) => {
        batches.push([...texts]);
        return texts.map((text) =>
          Array.from({ length: dimensions }, (_, i) =>
            i === 0 ? text.length : 0,
          ),
        );
      },
    },
  };
}

describe("createEmbeddingCache", () => {
  it("embeds on a miss and serves the second call from memory", async () => {
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir: tempDir() });
    const first = await cache.embed(["a", "bb"]);
    const second = await cache.embed(["a", "bb"]);
    expect(second).toEqual(first);
    expect(batches).toHaveLength(1);
    expect(cache.stats()).toEqual({ hits: 2, misses: 2, requests: 1 });
  });

  it("only asks for the texts it does not have", async () => {
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir: tempDir() });
    await cache.embed(["a"]);
    await cache.embed(["a", "b"]);
    expect(batches).toEqual([["a"], ["b"]]);
  });

  it("collapses a repeated text inside one batch", async () => {
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir: tempDir() });
    const vectors = await cache.embed(["same", "same", "other"]);
    expect(batches[0]).toEqual(["same", "other"]);
    expect(vectors[0]).toEqual(vectors[1]);
  });

  it("splits a large batch into requests of the configured size", async () => {
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, {
      dir: tempDir(),
      batchSize: 2,
    });
    await cache.embed(["a", "b", "c", "d", "e"]);
    expect(batches.map((batch) => batch.length)).toEqual([2, 2, 1]);
    expect(cache.stats().requests).toBe(3);
  });

  it("makes no request for an empty batch", async () => {
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir: tempDir() });
    await expect(cache.embed([])).resolves.toEqual([]);
    expect(batches).toHaveLength(0);
  });

  it("persists across processes, keyed by model", async () => {
    const dir = tempDir();
    const first = recordingEmbedder();
    const cacheA = createEmbeddingCache(first.embedder, { dir });
    await cacheA.embed(["hello"]);
    cacheA.save();

    const second = recordingEmbedder();
    const cacheB = createEmbeddingCache(second.embedder, { dir });
    await cacheB.embed(["hello"]);
    expect(second.batches).toHaveLength(0);
    expect(cacheB.stats().hits).toBe(1);

    // A different model must not read the first model's vectors.
    const other = recordingEmbedder(4, "other-model");
    const cacheC = createEmbeddingCache(other.embedder, { dir });
    await cacheC.embed(["hello"]);
    expect(other.batches).toEqual([["hello"]]);
  });

  it("re-embeds when the model dimensions change", async () => {
    const dir = tempDir();
    const small = recordingEmbedder(4);
    const cacheA = createEmbeddingCache(small.embedder, { dir });
    await cacheA.embed(["hello"]);
    cacheA.save();

    const large = recordingEmbedder(8);
    const cacheB = createEmbeddingCache(large.embedder, { dir });
    await cacheB.embed(["hello"]);
    expect(large.batches).toEqual([["hello"]]);
  });

  it("writes nothing when there was nothing new", async () => {
    const dir = tempDir();
    const { embedder } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir });
    cache.save();
    expect(() => readFileSync(cache.path, "utf8")).toThrow();
  });

  it("ignores a corrupt cache file instead of failing the run", async () => {
    const dir = tempDir();
    const { embedder, batches } = recordingEmbedder();
    const cache = createEmbeddingCache(embedder, { dir });
    await cache.embed(["hello"]);
    cache.save();
    writeFileSync(cache.path, "{not json", "utf8");

    const fresh = createEmbeddingCache(embedder, { dir });
    await fresh.embed(["hello"]);
    expect(batches).toHaveLength(2);
  });

  it("rejects a mismatched vector count from the embedder", async () => {
    const cache = createEmbeddingCache(
      {
        model: "broken",
        dimensions: 4,
        embed: async () => [[1, 0, 0, 0]],
      },
      { dir: tempDir() },
    );
    await expect(cache.embed(["a", "b"])).rejects.toThrow(/2 vectors/);
  });
});
