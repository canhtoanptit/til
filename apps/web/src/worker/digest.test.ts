import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BASE_SCORE_WEIGHT,
  DEFAULT_WINDOW_DAYS,
  INTEREST_SCORE_WEIGHT,
  MAX_INTEREST_VECTORS,
  MAX_WINDOW_DAYS,
  MIN_WINDOW_DAYS,
  MONTHLY_REPORT_CRON,
  MONTHLY_REPORT_WINDOW_DAYS,
  WEEKLY_CRON,
  blendRankedItems,
  blendScore,
  clampInterest,
  clampWindowDays,
  digestKindForCron,
  interestDominates,
  interestTextFor,
  normalizeDigestKind,
  rankingScore,
  toSynthesisInputs,
  type RankedItem,
} from "./digest.js";

function item(overrides: Partial<RankedItem> = {}): RankedItem {
  return {
    canonicalUrl: overrides.canonicalUrl ?? "https://example.com/a",
    url: overrides.url ?? "https://example.com/a",
    title: overrides.title ?? "A thing",
    sourceName: overrides.sourceName ?? "hn",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    sources: overrides.sources ?? ["hn"],
    publishedAt: overrides.publishedAt ?? 1_700_000_000_000,
    score: overrides.score ?? 0.5,
    evidence: overrides.evidence ?? [],
    ...(overrides.snippet === undefined ? {} : { snippet: overrides.snippet }),
    ...(overrides.interestScore === undefined
      ? {}
      : { interestScore: overrides.interestScore }),
    ...(overrides.blendedScore === undefined
      ? {}
      : { blendedScore: overrides.blendedScore }),
  };
}

describe("blend constants (C18)", () => {
  it("are the frozen 0.6 / 0.4 split and sum to one", () => {
    expect(BASE_SCORE_WEIGHT).toBe(0.6);
    expect(INTEREST_SCORE_WEIGHT).toBe(0.4);
    expect(BASE_SCORE_WEIGHT + INTEREST_SCORE_WEIGHT).toBeCloseTo(1, 12);
  });

  it("caps the interest profile at the 200 most recent vectors", () => {
    expect(MAX_INTEREST_VECTORS).toBe(200);
  });
});

describe("blendScore", () => {
  it("is 0.6 * base + 0.4 * interest", () => {
    expect(blendScore(0.5, 1)).toBeCloseTo(0.7, 12);
    expect(blendScore(1, 0)).toBeCloseTo(0.6, 12);
    expect(blendScore(0, 1)).toBeCloseTo(0.4, 12);
    expect(blendScore(0.25, 0.75)).toBeCloseTo(0.45, 12);
  });

  it("treats a negative similarity as no interest rather than a penalty", () => {
    expect(blendScore(0.5, -1)).toBeCloseTo(0.3, 12);
    expect(blendScore(0.5, -0.2)).toBe(blendScore(0.5, 0));
  });

  it("cannot be pushed above the base weight plus one by an out-of-range interest", () => {
    expect(blendScore(1, 5)).toBeCloseTo(1, 12);
    expect(blendScore(0, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("clampInterest", () => {
  it("clamps to 0..1 and maps non-finite values to 0", () => {
    expect(clampInterest(0.5)).toBe(0.5);
    expect(clampInterest(-3)).toBe(0);
    expect(clampInterest(2)).toBe(1);
    expect(clampInterest(Number.NaN)).toBe(0);
  });
});

describe("interestDominates", () => {
  it("is true only when the interest term outweighs the base term", () => {
    // 0.4 * 0.9 = 0.36 > 0.6 * 0.5 = 0.30
    expect(interestDominates(0.5, 0.9)).toBe(true);
    // 0.4 * 0.9 = 0.36 < 0.6 * 0.8 = 0.48
    expect(interestDominates(0.8, 0.9)).toBe(false);
  });

  it("is false at an exact tie, so the marker never claims a draw", () => {
    // 0.4 * 0.6 === 0.6 * 0.4
    expect(interestDominates(0.4, 0.6)).toBe(false);
  });

  it("is false for a zero interest even against a zero base score", () => {
    expect(interestDominates(0, 0)).toBe(false);
    expect(interestDominates(0, -1)).toBe(false);
  });

  it("is true for any real interest against a zero base score", () => {
    expect(interestDominates(0, 0.01)).toBe(true);
  });
});

describe("interestTextFor", () => {
  it("embeds title and snippet together", () => {
    expect(interestTextFor(item({ title: "T", snippet: "S" }))).toBe("T\nS");
  });

  it("falls back to the title alone when there is no usable snippet", () => {
    expect(interestTextFor(item({ title: " T " }))).toBe("T");
    expect(interestTextFor(item({ title: "T", snippet: "   " }))).toBe("T");
  });
});

describe("blendRankedItems", () => {
  it("attaches both halves of the blend and re-orders by the blended score", () => {
    const ranked = [
      item({ canonicalUrl: "hot", score: 0.9 }),
      item({ canonicalUrl: "mine", score: 0.4 }),
    ];

    // hot: 0.6*0.9 + 0.4*0.0 = 0.54; mine: 0.6*0.4 + 0.4*1.0 = 0.64
    const out = blendRankedItems(ranked, [0, 1]);

    expect(out.map((i) => i.canonicalUrl)).toEqual(["mine", "hot"]);
    expect(out[0]?.score).toBe(0.4);
    expect(out[0]?.interestScore).toBe(1);
    expect(out[0]?.blendedScore).toBeCloseTo(0.64, 12);
    expect(out[1]?.interestScore).toBe(0);
    expect(out[1]?.blendedScore).toBeCloseTo(0.54, 12);
  });

  it("leaves the base order alone when the blend ties", () => {
    const ranked = [
      item({ canonicalUrl: "first", score: 0.5 }),
      item({ canonicalUrl: "second", score: 0.5 }),
      item({ canonicalUrl: "third", score: 0.5 }),
    ];
    const out = blendRankedItems(ranked, [0.2, 0.2, 0.2]);
    expect(out.map((i) => i.canonicalUrl)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("never mutates the items it was given", () => {
    const ranked = [item({ score: 0.5 })];
    const out = blendRankedItems(ranked, [1]);
    expect(ranked[0]?.interestScore).toBeUndefined();
    expect(out[0]?.interestScore).toBe(1);
  });

  it("treats a missing interest as zero", () => {
    const out = blendRankedItems([item({ score: 0.5 })], []);
    expect(out[0]?.interestScore).toBe(0);
    expect(out[0]?.blendedScore).toBeCloseTo(0.3, 12);
  });
});

describe("rankingScore", () => {
  it("is the blend when personalization ran, and the base score otherwise", () => {
    expect(rankingScore(item({ score: 0.5 }))).toBe(0.5);
    expect(rankingScore(item({ score: 0.5, blendedScore: 0.64 }))).toBe(0.64);
  });
});

describe("toSynthesisInputs", () => {
  it("shows the model the score the pool was ordered by", () => {
    const inputs = toSynthesisInputs([
      item({ canonicalUrl: "a", score: 0.4, blendedScore: 0.64 }),
      item({ canonicalUrl: "b", score: 0.9 }),
    ]);
    expect(inputs[0]?.score).toBe(0.64);
    expect(inputs[1]?.score).toBe(0.9);
  });
});

describe("cron routing (P26)", () => {
  it("maps each configured cron expression to the run it should start", () => {
    expect(digestKindForCron(WEEKLY_CRON)).toBe("weekly");
    expect(digestKindForCron(MONTHLY_REPORT_CRON)).toBe("monthly-report");
  });

  it("falls back to the weekly digest for an expression nobody claimed", () => {
    // A cron added to wrangler.jsonc without a matching constant here still does
    // something useful rather than throwing inside the scheduled handler.
    expect(digestKindForCron("*/5 * * * *")).toBe("weekly");
    expect(digestKindForCron("")).toBe("weekly");
  });

  it("keeps the cron constants character-identical to wrangler.jsonc", () => {
    // Cloudflare compares controller.cron verbatim, so a stray double space in
    // either file would silently stop the monthly report from ever firing. This is
    // the only place the two spellings are checked against each other.
    const config = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../../wrangler.jsonc"),
      "utf8",
    );
    const crons = [
      ...config.matchAll(/"((?:[-\d*/,]+ ){4}[-\d*/,]+)"/g),
    ].map((match) => match[1]);
    expect(crons).toEqual([WEEKLY_CRON, MONTHLY_REPORT_CRON]);
  });
});

describe("normalizeDigestKind", () => {
  it("accepts the two known kinds and nothing else", () => {
    expect(normalizeDigestKind("weekly")).toBe("weekly");
    expect(normalizeDigestKind("monthly-report")).toBe("monthly-report");
  });

  it("reads anything unrecognized — including a pre-P26 payload — as weekly", () => {
    expect(normalizeDigestKind(undefined)).toBe("weekly");
    expect(normalizeDigestKind(null)).toBe("weekly");
    expect(normalizeDigestKind("monthly")).toBe("weekly");
    expect(normalizeDigestKind(7)).toBe("weekly");
  });
});

describe("clampWindowDays by kind", () => {
  it("defaults to 7 days for a weekly run and 30 for a monthly report", () => {
    expect(clampWindowDays(undefined)).toBe(DEFAULT_WINDOW_DAYS);
    expect(clampWindowDays(undefined, "weekly")).toBe(DEFAULT_WINDOW_DAYS);
    expect(clampWindowDays(undefined, "monthly-report")).toBe(
      MONTHLY_REPORT_WINDOW_DAYS,
    );
  });

  it("still clamps an explicit window the same way for both kinds", () => {
    expect(clampWindowDays(3, "monthly-report")).toBe(3);
    expect(clampWindowDays(999, "monthly-report")).toBe(MAX_WINDOW_DAYS);
    expect(clampWindowDays(0, "monthly-report")).toBe(MIN_WINDOW_DAYS);
  });
});
