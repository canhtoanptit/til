import { describe, expect, it } from "vitest";
import {
  cosineSimilarity,
  embeddingTextFor,
  normalizeVector,
  RRF_K,
  rrfMerge,
} from "./retrieval.js";

function magnitude(v: readonly number[]): number {
  let sum = 0;
  for (const value of v) sum += value * value;
  return Math.sqrt(sum);
}

describe("rrfMerge", () => {
  it("preserves order for a single list", () => {
    const merged = rrfMerge([
      [
        { id: "a", rank: 1 },
        { id: "b", rank: 2 },
        { id: "c", rank: 3 },
      ],
    ]);
    expect(merged.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("uses 1/(k + rank) with k defaulting to 60", () => {
    const merged = rrfMerge([[{ id: "a", rank: 1 }]]);
    expect(RRF_K).toBe(60);
    expect(merged[0]?.score).toBeCloseTo(1 / 61, 12);
  });

  it("ranks an id agreed on by two lists above another list's top hit", () => {
    const merged = rrfMerge([
      [
        { id: "a", rank: 1 },
        { id: "shared", rank: 2 },
      ],
      [
        { id: "z", rank: 1 },
        { id: "shared", rank: 2 },
      ],
    ]);
    expect(merged[0]?.id).toBe("shared");
    expect(merged[0]?.score).toBeCloseTo(2 / 62, 12);
    expect(merged[0]?.score).toBeCloseTo(0.03225806451612903, 12);
    const a = merged.find((m) => m.id === "a");
    expect(a?.score).toBeCloseTo(1 / 61, 12);
    expect(a?.score).toBeCloseTo(0.01639344262295082, 12);
    expect(2 / 62).toBeGreaterThan(1 / 61);
  });

  it("accumulates scores across all lists an id appears in", () => {
    const merged = rrfMerge([
      [{ id: "a", rank: 3 }],
      [{ id: "a", rank: 7 }],
      [{ id: "b", rank: 1 }],
    ]);
    const a = merged.find((m) => m.id === "a");
    expect(a?.score).toBeCloseTo(1 / 63 + 1 / 67, 12);
    expect(merged[0]?.id).toBe("a");
  });

  it("breaks ties deterministically by id ascending", () => {
    const merged = rrfMerge([
      [
        { id: "delta", rank: 1 },
        { id: "alpha", rank: 1 },
        { id: "charlie", rank: 1 },
        { id: "bravo", rank: 1 },
      ],
    ]);
    expect(merged.map((m) => m.id)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
    ]);
    const scores = new Set(merged.map((m) => m.score));
    expect(scores.size).toBe(1);
  });

  it("tolerates no lists, empty lists, and a mix", () => {
    expect(rrfMerge([])).toEqual([]);
    expect(rrfMerge([[], []])).toEqual([]);
    const merged = rrfMerge([[], [{ id: "a", rank: 1 }], []]);
    expect(merged).toEqual([{ id: "a", score: 1 / 61 }]);
  });

  it("honours a custom k", () => {
    const merged = rrfMerge([[{ id: "a", rank: 1 }]], 10);
    expect(merged[0]?.score).toBeCloseTo(1 / 11, 12);
  });

  it("makes rank differences matter more with a small k", () => {
    const lists = [
      [
        { id: "first", rank: 1 },
        { id: "second", rank: 2 },
      ],
    ];
    const big = rrfMerge(lists, 1000);
    const small = rrfMerge(lists, 1);
    const bigRatio = (big[0]?.score ?? 0) / (big[1]?.score ?? 1);
    const smallRatio = (small[0]?.score ?? 0) / (small[1]?.score ?? 1);
    expect(smallRatio).toBeGreaterThan(bigRatio);
    expect(smallRatio).toBeCloseTo(1.5, 12);
  });

  it("skips entries whose rank would produce a non-finite score", () => {
    const merged = rrfMerge([
      [
        { id: "ok", rank: 1 },
        { id: "nan", rank: Number.NaN },
        { id: "pole", rank: -60 },
      ],
    ]);
    expect(merged.map((m) => m.id)).toEqual(["ok"]);
    expect(Number.isFinite(merged[0]?.score ?? Number.NaN)).toBe(true);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 12);
  });

  it("returns 1 for parallel vectors of different magnitude", () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    expect(cosineSimilarity([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
  });

  it("returns 0 (never NaN) for a zero-magnitude vector", () => {
    const score = cosineSimilarity([0, 0, 0], [1, 2, 3]);
    expect(score).toBe(0);
    expect(Number.isNaN(score)).toBe(false);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it("throws a clear error on length mismatch", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow(
      /lengths differ \(3 vs 2\)/,
    );
  });

  it("equals the dot product for unit vectors", () => {
    const a = normalizeVector([3, 1, 4, 1]);
    const b = normalizeVector([2, 7, 1, 8]);
    let dot = 0;
    for (let i = 0; i < a.length; i += 1) dot += (a[i] ?? 0) * (b[i] ?? 0);
    expect(cosineSimilarity(a, b)).toBeCloseTo(dot, 12);
  });
});

describe("normalizeVector", () => {
  it("returns a unit-length vector", () => {
    expect(magnitude(normalizeVector([3, 4]))).toBeCloseTo(1, 12);
    expect(magnitude(normalizeVector([0.1, -0.2, 0.3, 12]))).toBeCloseTo(1, 12);
  });

  it("preserves direction", () => {
    const normalized = normalizeVector([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6, 12);
    expect(normalized[1]).toBeCloseTo(0.8, 12);
    expect(cosineSimilarity(normalized, [3, 4])).toBeCloseTo(1, 12);
  });

  it("leaves an already-normalized vector unchanged", () => {
    const unit = [0, 1, 0];
    expect(normalizeVector(unit)).toEqual([0, 1, 0]);
  });

  it("returns a zero vector as-is instead of NaNs", () => {
    const zero = [0, 0, 0];
    expect(normalizeVector(zero)).toEqual([0, 0, 0]);
    expect(normalizeVector([])).toEqual([]);
  });
});

describe("embeddingTextFor", () => {
  it("lays out title, takeaway, summary, then tags", () => {
    expect(
      embeddingTextFor({
        title: "Vectors at the edge",
        takeaway: "Brute force is fine at small n.",
        summary: "A long-ish summary.",
        tags: ["vectors", "edge-compute"],
      }),
    ).toBe(
      "Vectors at the edge\nBrute force is fine at small n.\nA long-ish summary.\nTags: vectors, edge-compute",
    );
  });

  it("skips null and missing fields", () => {
    expect(
      embeddingTextFor({
        title: "Only a title",
        takeaway: null,
        summary: null,
        tags: null,
      }),
    ).toBe("Only a title");
    expect(embeddingTextFor({ title: "Bare" })).toBe("Bare");
    expect(embeddingTextFor({ takeaway: "No title here", tags: ["a"] })).toBe(
      "No title here\nTags: a",
    );
  });

  it("drops empty and whitespace-only parts", () => {
    expect(
      embeddingTextFor({
        title: "  Trimmed  ",
        takeaway: "   ",
        summary: "",
        tags: ["  spaced  ", "", "   "],
      }),
    ).toBe("Trimmed\nTags: spaced");
  });

  it("omits the tags line when there are no tags", () => {
    const text = embeddingTextFor({ title: "T", summary: "S", tags: [] });
    expect(text).toBe("T\nS");
    expect(text).not.toContain("Tags:");
  });

  it("returns an empty string when there is nothing to embed", () => {
    expect(embeddingTextFor({})).toBe("");
    expect(
      embeddingTextFor({
        title: null,
        takeaway: null,
        summary: null,
        tags: [],
      }),
    ).toBe("");
  });
});
