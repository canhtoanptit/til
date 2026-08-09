import { describe, expect, it } from "vitest";
import { mean, mrr, ndcgAtK, precision, recallAtK } from "./metrics.js";

const LOG2_3 = Math.log2(3);

describe("recallAtK", () => {
  it("is 1 when every gold entry is inside k", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "b"], 3)).toBe(1);
    expect(recallAtK(["a", "b"], ["b"], 2)).toBe(1);
  });

  it("is 0 when no gold entry is inside k", () => {
    expect(recallAtK(["x", "y", "z"], ["a"], 3)).toBe(0);
    expect(recallAtK([], ["a"], 5)).toBe(0);
  });

  it("counts the fraction of the gold set found, not of the list", () => {
    expect(recallAtK(["a", "x", "y", "z"], ["a", "b"], 4)).toBe(0.5);
    expect(recallAtK(["a", "b", "c"], ["a", "b", "c", "d"], 3)).toBeCloseTo(
      0.75,
      12,
    );
  });

  it("respects the cutoff", () => {
    expect(recallAtK(["x", "a"], ["a"], 1)).toBe(0);
    expect(recallAtK(["x", "a"], ["a"], 2)).toBe(1);
  });

  it("uses the whole list when k exceeds its length", () => {
    expect(recallAtK(["a"], ["a"], 100)).toBe(1);
  });

  it("scores 0 for a non-positive or non-finite k", () => {
    expect(recallAtK(["a"], ["a"], 0)).toBe(0);
    expect(recallAtK(["a"], ["a"], -3)).toBe(0);
    expect(recallAtK(["a"], ["a"], Number.NaN)).toBe(0);
    expect(recallAtK(["a"], ["a"], Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("counts a duplicated id once, at its first position", () => {
    expect(recallAtK(["a", "a", "a"], ["a", "b"], 3)).toBe(0.5);
    // Padding with duplicates must not push a real hit inside the cutoff.
    expect(recallAtK(["x", "x", "b"], ["b"], 2)).toBe(1);
  });

  it("scores an empty gold set 0, marking the dataset bug", () => {
    expect(recallAtK(["a"], [], 5)).toBe(0);
  });

  it("ignores duplicates inside the gold set", () => {
    expect(recallAtK(["a"], ["a", "a"], 1)).toBe(1);
  });
});

describe("mrr", () => {
  it("is 1 when the first result is relevant", () => {
    expect(mrr(["a", "b"], ["a"])).toBe(1);
  });

  it("is the reciprocal of the first relevant rank", () => {
    expect(mrr(["x", "a"], ["a"])).toBe(0.5);
    expect(mrr(["x", "y", "a"], ["a"])).toBeCloseTo(1 / 3, 12);
    expect(mrr(["x", "y", "z", "a"], ["a"])).toBe(0.25);
  });

  it("takes the earliest of several gold entries", () => {
    expect(mrr(["x", "b", "a"], ["a", "b"])).toBe(0.5);
  });

  it("is 0 when nothing relevant is retrieved", () => {
    expect(mrr(["x", "y"], ["a"])).toBe(0);
    expect(mrr([], ["a"])).toBe(0);
  });

  it("has no cutoff: a hit deep in the list still scores", () => {
    const ranked = [...Array.from({ length: 99 }, (_, i) => `x${i}`), "a"];
    expect(mrr(ranked, ["a"])).toBeCloseTo(1 / 100, 12);
  });

  it("collapses duplicates before ranking", () => {
    expect(mrr(["x", "x", "a"], ["a"])).toBe(0.5);
  });

  it("scores an empty gold set 0", () => {
    expect(mrr(["a"], [])).toBe(0);
  });
});

describe("ndcgAtK", () => {
  it("is 1 for a perfect single-gold ranking", () => {
    expect(ndcgAtK(["a", "b", "c"], ["a"], 3)).toBe(1);
  });

  it("applies the log2 discount at rank 2", () => {
    expect(ndcgAtK(["x", "a"], ["a"], 2)).toBeCloseTo(1 / LOG2_3, 12);
    expect(ndcgAtK(["x", "a"], ["a"], 2)).toBeCloseTo(0.6309, 4);
  });

  it("is 1 only when every gold entry leads the list", () => {
    expect(ndcgAtK(["a", "b", "x"], ["a", "b"], 3)).toBe(1);
    const one = 1 + 1 / Math.log2(4);
    const ideal = 1 + 1 / LOG2_3;
    expect(ndcgAtK(["a", "x", "b"], ["a", "b"], 3)).toBeCloseTo(
      one / ideal,
      12,
    );
  });

  it("is 0 when nothing relevant is inside k", () => {
    expect(ndcgAtK(["x", "y", "a"], ["a"], 2)).toBe(0);
    expect(ndcgAtK([], ["a"], 5)).toBe(0);
  });

  it("normalises against a reachable ideal, not against the gold size", () => {
    // Only one of two gold entries can fit at k=1, so a hit at rank 1 is perfect.
    expect(ndcgAtK(["a", "b"], ["a", "b"], 1)).toBe(1);
  });

  it("scores 0 for a non-positive or non-finite k", () => {
    expect(ndcgAtK(["a"], ["a"], 0)).toBe(0);
    expect(ndcgAtK(["a"], ["a"], Number.NaN)).toBe(0);
  });

  it("collapses duplicates before discounting", () => {
    expect(ndcgAtK(["a", "a"], ["a"], 2)).toBe(1);
    expect(ndcgAtK(["x", "x", "a"], ["a"], 2)).toBeCloseTo(1 / LOG2_3, 12);
  });

  it("scores an empty gold set 0", () => {
    expect(ndcgAtK(["a"], [], 3)).toBe(0);
  });

  it("never exceeds 1 and never goes below 0", () => {
    const lists = [["a", "b", "c"], ["c", "b", "a"], ["x", "a", "y", "b"], []];
    for (const list of lists) {
      for (const gold of [["a"], ["a", "b"], ["a", "b", "c"]]) {
        const score = ndcgAtK(list, gold, 10);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("ranks a better ordering strictly higher", () => {
    const good = ndcgAtK(["a", "b", "x", "y"], ["a", "b"], 4);
    const worse = ndcgAtK(["x", "a", "y", "b"], ["a", "b"], 4);
    expect(good).toBeGreaterThan(worse);
  });
});

describe("mean", () => {
  it("averages a sample", () => {
    expect(mean([1, 0])).toBe(0.5);
    expect(mean([0.25, 0.5, 0.75])).toBeCloseTo(0.5, 12);
  });

  it("is 0 for an empty sample", () => {
    expect(mean([])).toBe(0);
  });
});

describe("precision", () => {
  it("is 1 when every claim is permitted", () => {
    expect(precision(["u1", "u2"], ["u1", "u2", "u3"])).toBe(1);
  });

  it("is the permitted fraction of the claims", () => {
    expect(precision(["u1", "bad"], ["u1"])).toBe(0.5);
    expect(precision(["bad"], ["u1"])).toBe(0);
  });

  it("treats an empty claim set as vacuously precise", () => {
    expect(precision([], [])).toBe(1);
    expect(precision([], ["u1"])).toBe(1);
  });

  it("counts a repeated claim once", () => {
    expect(precision(["u1", "u1", "bad"], ["u1"])).toBe(0.5);
  });
});
