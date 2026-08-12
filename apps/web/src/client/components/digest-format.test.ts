import { describe, expect, it } from "vitest";
import {
  formatItemCount,
  formatScore,
  matchesYourReading,
  sourceLabel,
} from "./digest-format";

describe("matchesYourReading", () => {
  it("marks an item when the interest term outweighed the base term", () => {
    // 0.4 * 0.9 = 0.36 > 0.6 * 0.5 = 0.30
    expect(matchesYourReading(0.5, 0.9)).toBe(true);
  });

  it("leaves a loud-but-unrelated item unmarked", () => {
    // 0.4 * 0.9 = 0.36 < 0.6 * 0.8 = 0.48
    expect(matchesYourReading(0.8, 0.9)).toBe(false);
  });

  it("does not mark an exact tie", () => {
    expect(matchesYourReading(0.4, 0.6)).toBe(false);
  });

  it("never marks an item from a run that was not personalized", () => {
    expect(matchesYourReading(0.5, null)).toBe(false);
    // The dangerous case: a null interest against a zero base score.
    expect(matchesYourReading(0, null)).toBe(false);
  });

  it("treats a zero or negative similarity as no match", () => {
    expect(matchesYourReading(0, 0)).toBe(false);
    expect(matchesYourReading(0, -1)).toBe(false);
  });

  it("ignores non-finite numbers instead of marking on them", () => {
    expect(matchesYourReading(0.5, Number.NaN)).toBe(false);
    expect(matchesYourReading(Number.NaN, 0.9)).toBe(false);
  });
});

describe("formatScore", () => {
  it("renders two decimals, and nothing for a non-number", () => {
    expect(formatScore(0.8210001)).toBe("0.82");
    expect(formatScore(Number.NaN)).toBeNull();
  });
});

describe("sourceLabel", () => {
  it("names the known aggregators and per-host RSS feeds", () => {
    expect(sourceLabel("hn")).toBe("Hacker News");
    expect(sourceLabel("rss:jvns.ca")).toBe("RSS · jvns.ca");
    expect(sourceLabel("rss:")).toBe("RSS");
    expect(sourceLabel("mystery")).toBe("mystery");
  });
});

describe("formatItemCount", () => {
  it("pluralizes", () => {
    expect(formatItemCount(1)).toBe("1 item");
    expect(formatItemCount(3)).toBe("3 items");
    expect(formatItemCount(Number.NaN)).toBe("0 items");
  });
});
