import { describe, expect, it } from "vitest";
import type { Embedder, VectorStore } from "@til/core";
import { loadInterestProfile, personalizeRanked } from "./digest-interest.js";
import { MAX_INTEREST_VECTORS, type RankedItem } from "./digest.js";
import type { Deps } from "./deps.js";
import { buildTestApp, insertEntry, makeStubEmbedder } from "./test-harness.js";

const NOW = 1_700_000_000_000;
// Small on purpose: the stub embedder projects onto one axis per topic, so 8
// dimensions is enough to model "related" and "unrelated" without 1024-wide rows.
const DIMS = 8;

/** Axis 0 = rust, 1 = sqlite, 2 = kafka; anything else lands on the last axis. */
const TOPICS = [["rust"], ["sqlite"], ["kafka"]];

function stubEmbedder(onEmbed?: (texts: string[]) => void): Embedder {
  return makeStubEmbedder(
    TOPICS,
    onEmbed === undefined
      ? { dimensions: DIMS }
      : { dimensions: DIMS, onEmbed },
  );
}

/** A store whose reads all behave the same way, whatever the id. */
function fakeStore(getVector: () => Promise<number[] | null>): VectorStore {
  return {
    upsert: async () => {},
    query: async () => [],
    deleteByIds: async () => {},
    getVector,
  };
}

function item(overrides: Partial<RankedItem> = {}): RankedItem {
  return {
    canonicalUrl: overrides.canonicalUrl ?? "https://example.com/a",
    url: overrides.url ?? "https://example.com/a",
    title: overrides.title ?? "A thing",
    sourceName: overrides.sourceName ?? "hn",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    sources: overrides.sources ?? ["hn"],
    publishedAt: overrides.publishedAt ?? NOW,
    score: overrides.score ?? 0.5,
    evidence: [],
    ...(overrides.snippet === undefined ? {} : { snippet: overrides.snippet }),
  };
}

/** An entry plus its stored vector, embedded from `text` by the stub embedder. */
async function saveRead(
  deps: Deps,
  opts: { id: string; text: string; createdAt: number; indexed?: boolean },
): Promise<void> {
  await insertEntry(deps.db, {
    id: opts.id,
    url: `https://example.com/${opts.id}`,
    canonicalUrl: `https://example.com/${opts.id}`,
    title: opts.text,
    createdAt: opts.createdAt,
  });
  if (opts.indexed === false) return;
  const store = deps.vectorStore;
  if (!store) throw new Error("test setup: no vector store");
  const [values] = await stubEmbedder().embed([opts.text]);
  if (!values) throw new Error("test setup: stub returned no vector");
  await store.upsert([
    {
      id: opts.id,
      userId: "owner",
      values,
      metadata: {
        domain: "example.com",
        createdAt: opts.createdAt,
        embedModel: "stub-embed",
      },
    },
  ]);
}

describe("loadInterestProfile", () => {
  it("reads the most recently saved entries' vectors, newest first", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, { id: "old", text: "rust", createdAt: NOW - 3000 });
    await saveRead(t.deps, {
      id: "mid",
      text: "sqlite",
      createdAt: NOW - 2000,
    });
    await saveRead(t.deps, { id: "new", text: "kafka", createdAt: NOW - 1000 });

    const profile = await loadInterestProfile(t.deps, "owner");

    expect(profile).toHaveLength(3);
    // kafka is axis 2, sqlite axis 1, rust axis 0 — newest first.
    expect(profile[0]?.[2]).toBe(1);
    expect(profile[1]?.[1]).toBe(1);
    expect(profile[2]?.[0]).toBe(1);
  });

  it("honours a smaller limit, keeping the newest entries", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, { id: "old", text: "rust", createdAt: NOW - 3000 });
    await saveRead(t.deps, { id: "new", text: "kafka", createdAt: NOW - 1000 });

    const profile = await loadInterestProfile(t.deps, "owner", 1);

    expect(profile).toHaveLength(1);
    expect(profile[0]?.[2]).toBe(1);
  });

  it("skips entries with no stored vector, and entries that are not ready", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, {
      id: "unindexed",
      text: "rust",
      createdAt: NOW - 3000,
      indexed: false,
    });
    await saveRead(t.deps, {
      id: "indexed",
      text: "kafka",
      createdAt: NOW - 2000,
    });
    await insertEntry(t.deps.db, {
      id: "pending",
      url: "https://example.com/pending",
      canonicalUrl: "https://example.com/pending",
      status: "pending",
      createdAt: NOW - 1000,
    });

    const profile = await loadInterestProfile(t.deps, "owner");

    expect(profile).toHaveLength(1);
    expect(profile[0]?.[2]).toBe(1);
  });

  it("is empty when nothing is saved", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    expect(await loadInterestProfile(t.deps, "owner")).toEqual([]);
  });

  it("is empty when there is no vector store to read", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder(),
      vectorStore: null,
    });
    await saveRead(t.deps, {
      id: "a",
      text: "rust",
      createdAt: NOW,
      indexed: false,
    });
    expect(await loadInterestProfile(t.deps, "owner")).toEqual([]);
  });
});

describe("personalizeRanked", () => {
  it("scores each item by its closest match in the profile, not its average", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, { id: "a", text: "rust", createdAt: NOW - 2000 });
    await saveRead(t.deps, { id: "b", text: "kafka", createdAt: NOW - 1000 });

    const result = await personalizeRanked(t.deps, "owner", [
      item({ canonicalUrl: "r", title: "rust release notes", score: 0.5 }),
      item({ canonicalUrl: "z", title: "something unrelated", score: 0.5 }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.profileSize).toBe(2);
    // One exact axis match out of two profile vectors — max, not mean (0.5).
    const rust = result?.items.find((i) => i.canonicalUrl === "r");
    expect(rust?.interestScore).toBeCloseTo(1, 12);
    expect(rust?.blendedScore).toBeCloseTo(0.7, 12);
    const other = result?.items.find((i) => i.canonicalUrl === "z");
    expect(other?.interestScore).toBeCloseTo(0, 12);
    expect(other?.blendedScore).toBeCloseTo(0.3, 12);
    expect(result?.items.map((i) => i.canonicalUrl)).toEqual(["r", "z"]);
  });

  it("compares against at most the 200 most recent vectors", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    // The one entry that would match is older than 200 newer, unrelated ones.
    await saveRead(t.deps, {
      id: "ancient-rust",
      text: "rust",
      createdAt: NOW - 999_999,
    });
    for (let i = 0; i < MAX_INTEREST_VECTORS; i += 1) {
      await saveRead(t.deps, {
        id: `recent-${i}`,
        text: "kafka",
        createdAt: NOW - 1000 + i,
      });
    }

    const result = await personalizeRanked(t.deps, "owner", [
      item({ title: "rust release notes" }),
    ]);

    expect(result?.profileSize).toBe(MAX_INTEREST_VECTORS);
    expect(result?.items[0]?.interestScore).toBeCloseTo(0, 12);

    // Control: put the rust entry inside the newest 200 and the match comes back.
    await saveRead(t.deps, { id: "fresh-rust", text: "rust", createdAt: NOW });
    const after = await personalizeRanked(t.deps, "owner", [
      item({ title: "rust release notes" }),
    ]);
    expect(after?.profileSize).toBe(MAX_INTEREST_VECTORS);
    expect(after?.items[0]?.interestScore).toBeCloseTo(1, 12);
  });

  it("returns null, without embedding anything, when nothing has been saved yet", async () => {
    const embedded: string[][] = [];
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder((texts) => embedded.push(texts)),
    });

    expect(await personalizeRanked(t.deps, "owner", [item()])).toBeNull();
    expect(embedded).toEqual([]);
  });

  it("returns null when there is no embedder, no vector store, or nothing ranked", async () => {
    const noEmbedder = buildTestApp({ now: () => NOW });
    expect(
      await personalizeRanked(noEmbedder.deps, "owner", [item()]),
    ).toBeNull();

    const noStore = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder(),
      vectorStore: null,
    });
    expect(await personalizeRanked(noStore.deps, "owner", [item()])).toBeNull();

    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, { id: "a", text: "rust", createdAt: NOW });
    expect(await personalizeRanked(t.deps, "owner", [])).toBeNull();
  });

  it("embeds title and snippet for every item in one batch", async () => {
    const embedded: string[][] = [];
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder((texts) => embedded.push(texts)),
    });
    await saveRead(t.deps, { id: "a", text: "rust", createdAt: NOW });

    await personalizeRanked(t.deps, "owner", [
      item({ canonicalUrl: "1", title: "one", snippet: "first snippet" }),
      item({ canonicalUrl: "2", title: "two" }),
    ]);

    expect(embedded).toEqual([["one\nfirst snippet", "two"]]);
  });

  it("throws when the embedder throws, so the step can retry before degrading", async () => {
    const throwing: Embedder = {
      model: "stub-embed",
      dimensions: DIMS,
      embed: async () => {
        throw new Error("ollama unreachable");
      },
    };
    const t = buildTestApp({ now: () => NOW, embedder: throwing });
    await saveRead(t.deps, { id: "a", text: "rust", createdAt: NOW });

    await expect(personalizeRanked(t.deps, "owner", [item()])).rejects.toThrow(
      "ollama unreachable",
    );
  });

  it("throws when the embedder returns fewer vectors than items", async () => {
    const short: Embedder = {
      model: "stub-embed",
      dimensions: DIMS,
      embed: async () => [],
    };
    const t = buildTestApp({ now: () => NOW, embedder: short });
    await saveRead(t.deps, { id: "a", text: "rust", createdAt: NOW });

    await expect(personalizeRanked(t.deps, "owner", [item()])).rejects.toThrow(
      "embedder returned 0 vector(s) for 1 item(s)",
    );
  });

  it("throws when the vector store throws, rather than silently scoring zero", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, {
      id: "a",
      text: "rust",
      createdAt: NOW,
      indexed: false,
    });
    const broken = fakeStore(async () => {
      throw new Error("vectorize is down");
    });

    await expect(
      personalizeRanked({ ...t.deps, vectorStore: broken }, "owner", [item()]),
    ).rejects.toThrow("vectorize is down");
  });

  it("ignores profile vectors whose dimensions no longer match", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: stubEmbedder() });
    await saveRead(t.deps, {
      id: "a",
      text: "rust",
      createdAt: NOW,
      indexed: false,
    });
    const stale = fakeStore(async () => [1, 0, 0]);

    const result = await personalizeRanked(
      { ...t.deps, vectorStore: stale },
      "owner",
      [item({ title: "rust release notes", score: 0.5 })],
    );

    expect(result?.profileSize).toBe(1);
    expect(result?.items[0]?.interestScore).toBe(0);
    expect(result?.items[0]?.blendedScore).toBeCloseTo(0.3, 12);
  });
});
