import { describe, expect, it } from "vitest";
import {
  digestHeading,
  digestKindLabel,
  digestRunCopy,
  formatItemCount,
  formatScore,
  matchesYourReading,
  sourceLabel,
} from "./digest-format";
import type { DigestSummaryDTO } from "../api";

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

  it("names the monthly report's own source", () => {
    // REPORT_ITEM_SOURCE_NAME in the worker; a report item has no aggregator.
    expect(sourceLabel("saved")).toBe("Saved");
  });
});

describe("digestKindLabel", () => {
  it("names both flavours", () => {
    expect(digestKindLabel("weekly")).toBe("Weekly digest");
    expect(digestKindLabel("monthly-report")).toBe("Monthly report");
  });
});

describe("digestRunCopy", () => {
  it("says what each kind is actually doing", () => {
    expect(digestRunCopy("weekly")).toEqual({
      startedTitle: "Digest run started",
      startedDescription:
        "Gathering and ranking candidates — this takes a minute or two.",
      failedTitle: "Could not start a digest run",
    });
    expect(digestRunCopy("monthly-report")).toEqual({
      startedTitle: "Report run started",
      startedDescription:
        "Reading back over the month — this takes a minute or two.",
      failedTitle: "Could not start a report run",
    });
  });

  it("never describes a report as a digest, or the reverse", () => {
    // The two runs read different sources; a toast that named the wrong one would
    // be the reader's only clue that the wrong kind was started.
    const weekly = digestRunCopy("weekly");
    const report = digestRunCopy("monthly-report");
    for (const key of [
      "startedTitle",
      "startedDescription",
      "failedTitle",
    ] as const) {
      expect(weekly[key]).not.toBe(report[key]);
    }
    expect(report.startedTitle).not.toMatch(/digest/i);
    expect(weekly.startedTitle).not.toMatch(/report/i);
  });
});

describe("digestHeading", () => {
  function summary(
    overrides: Partial<DigestSummaryDTO> = {},
  ): DigestSummaryDTO {
    return {
      id: "d1",
      runAt: Date.UTC(2026, 6, 31),
      windowDays: 7,
      kind: "weekly",
      status: "ready",
      title: null,
      intro: null,
      itemCount: 0,
      error: null,
      ...overrides,
    };
  }

  it("prefers the title the model wrote", () => {
    expect(digestHeading(summary({ title: "  A month of databases  " }))).toBe(
      "A month of databases",
    );
  });

  it("falls back to the kind and the window, not a generic 'Digest'", () => {
    expect(digestHeading(summary())).toContain("Weekly digest · ");
    expect(
      digestHeading(summary({ kind: "monthly-report", windowDays: 30 })),
    ).toContain("Monthly report · ");
  });

  it("still names the kind when the window cannot be formatted", () => {
    expect(
      digestHeading(summary({ kind: "monthly-report", runAt: Number.NaN })),
    ).toBe("Monthly report");
  });
});

describe("formatItemCount", () => {
  it("pluralizes", () => {
    expect(formatItemCount(1)).toBe("1 item");
    expect(formatItemCount(3)).toBe("3 items");
    expect(formatItemCount(Number.NaN)).toBe("0 items");
  });
});
