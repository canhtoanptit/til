import { describe, expect, it, vi } from "vitest";
import {
  clusterCandidates,
  scoreClusters,
  titleSimilarity,
  titleTokens,
} from "./ranking.js";
import type { Candidate, EvidenceCluster, ScoredCluster } from "./types.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NOW = Date.parse("2024-01-20T12:00:00Z");

function candidate(spec: {
  url: string;
  title: string;
  sourceName: string;
  publishedAt?: number;
  popularity?: number;
  snippet?: string;
}): Candidate {
  const out: Candidate = {
    url: spec.url,
    title: spec.title,
    sourceName: spec.sourceName,
    publishedAt: spec.publishedAt ?? NOW - DAY_MS,
  };
  if (spec.popularity !== undefined) out.popularity = spec.popularity;
  if (spec.snippet !== undefined) out.snippet = spec.snippet;
  return out;
}

function makeCluster(spec: {
  canonicalUrl: string;
  publishedAt: number;
  members: readonly { sourceName: string; popularity?: number }[];
  title?: string;
}): EvidenceCluster {
  const title = spec.title ?? "A perfectly ordinary article title";
  const candidates = spec.members.map((member) =>
    candidate({
      url: spec.canonicalUrl,
      title,
      sourceName: member.sourceName,
      publishedAt: spec.publishedAt,
      ...(member.popularity === undefined
        ? {}
        : { popularity: member.popularity }),
    }),
  );
  return {
    canonicalUrl: spec.canonicalUrl,
    title,
    candidates,
    sources: [...new Set(candidates.map((c) => c.sourceName))].sort(),
    publishedAt: spec.publishedAt,
  };
}

function scoreOf(
  scored: readonly ScoredCluster[],
  canonicalUrl: string,
): number {
  const found = scored.find((c) => c.canonicalUrl === canonicalUrl);
  if (found === undefined) {
    throw new Error(`no scored cluster for ${canonicalUrl}`);
  }
  return found.score;
}

function decimalPlaces(value: number): number {
  const [, fraction = ""] = String(value).split(".");
  return fraction.length;
}

describe("titleTokens", () => {
  it("drops stopwords, aggregator prefixes and punctuation", () => {
    expect([
      ...titleTokens("Show HN: A tour of the Rust borrow checker"),
    ]).toEqual(["tour", "rust", "borrow", "checker"]);
  });

  it("is case- and punctuation-insensitive", () => {
    expect([...titleTokens("Rust: Ownership, Rules!")]).toEqual([
      "rust",
      "ownership",
      "rules",
    ]);
  });

  it("keeps single digits but drops single letters", () => {
    expect([...titleTokens("Rust 1 2 3 a b")]).toEqual(["rust", "1", "2", "3"]);
  });
});

describe("titleSimilarity", () => {
  it("scores identical content tokens as 1", () => {
    expect(
      titleSimilarity("Rust ownership rules", "rust ownership rules!"),
    ).toBe(1);
  });

  it("scores disjoint titles as 0", () => {
    expect(
      titleSimilarity("Rust ownership rules", "Postgres index internals"),
    ).toBe(0);
  });

  it("scores an empty token set as 0", () => {
    expect(titleSimilarity("a", "b")).toBe(0);
  });
});

describe("clusterCandidates", () => {
  it("merges the same story across sources when URLs differ only by noise", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://example.com/post?utm_source=lobsters",
        title: "Understanding Rust ownership rules",
        sourceName: "lobsters",
        publishedAt: NOW - 2 * HOUR_MS,
        popularity: 30,
      }),
      candidate({
        url: "https://example.com/post#comments",
        title: "Understanding Rust ownership rules",
        sourceName: "rss:blog.example.com",
        publishedAt: NOW - 5 * HOUR_MS,
      }),
      candidate({
        url: "https://example.com/post/",
        title: "Understanding Rust ownership rules",
        sourceName: "hn",
        publishedAt: NOW - 3 * HOUR_MS,
        popularity: 120,
      }),
    ]);

    expect(clusters).toHaveLength(1);
    const cluster = clusters[0]!;
    expect(cluster.canonicalUrl).toBe("https://example.com/post");
    expect(cluster.sources).toEqual(["hn", "lobsters", "rss:blog.example.com"]);
    expect(cluster.candidates).toHaveLength(3);
    expect(cluster.publishedAt).toBe(NOW - 5 * HOUR_MS);
  });

  it("merges near-identical titles published at different URLs", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://a.example.com/rust-ownership",
        title: "Rust ownership rules explained",
        sourceName: "hn",
        popularity: 200,
      }),
      candidate({
        url: "https://b.example.com/mirror",
        title: "Rust ownership rules explained in depth",
        sourceName: "lobsters",
        popularity: 20,
      }),
    ]);

    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sources).toEqual(["hn", "lobsters"]);
  });

  it("keeps clearly different titles apart", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://a.example.com/rust",
        title: "Understanding Rust ownership and borrowing",
        sourceName: "hn",
      }),
      candidate({
        url: "https://b.example.com/go",
        title: "Understanding Go concurrency and channels",
        sourceName: "hn",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("does not merge titles that fall just below the similarity threshold", () => {
    // 3 of 4 shared tokens = 0.75 similarity, under the 0.8 merge threshold.
    const clusters = clusterCandidates([
      candidate({
        url: "https://a.example.com/one",
        title: "Rust ownership rules",
        sourceName: "hn",
      }),
      candidate({
        url: "https://b.example.com/two",
        title: "Rust ownership rules explained",
        sourceName: "lobsters",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("refuses to merge low-signal titles even when identical", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://a.example.com/weekly-1",
        title: "Weekly links",
        sourceName: "rss:a.example.com",
      }),
      candidate({
        url: "https://b.example.com/weekly-2",
        title: "Weekly links",
        sourceName: "rss:b.example.com",
      }),
    ]);

    expect(clusters).toHaveLength(2);
  });

  it("drops candidates with unusable URLs or blank titles", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "not a url",
        title: "Perfectly fine title here",
        sourceName: "hn",
      }),
      candidate({
        url: "https://example.com/blank",
        title: "   ",
        sourceName: "hn",
      }),
      candidate({
        url: "https://example.com/keep",
        title: "The only survivor",
        sourceName: "hn",
      }),
    ]);

    expect(clusters.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/keep",
    ]);
  });

  it("prefers a complete title over a longer truncated one", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://example.com/post",
        title: "Understanding Rust ownership rules and borrowing in de…",
        sourceName: "hn",
      }),
      candidate({
        url: "https://example.com/post",
        title: "Understanding Rust ownership",
        sourceName: "lobsters",
      }),
    ]);

    expect(clusters[0]!.title).toBe("Understanding Rust ownership");
  });

  it("prefers the longer of two complete titles", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://example.com/post",
        title: "Understanding Rust ownership",
        sourceName: "hn",
      }),
      candidate({
        url: "https://example.com/post",
        title: "Understanding Rust ownership and borrowing",
        sourceName: "lobsters",
      }),
    ]);

    expect(clusters[0]!.title).toBe(
      "Understanding Rust ownership and borrowing",
    );
  });

  it("returns clusters newest first with a URL tiebreak", () => {
    const clusters = clusterCandidates([
      candidate({
        url: "https://example.com/zebra",
        title: "Same age zebra story",
        sourceName: "hn",
        publishedAt: NOW - 2 * DAY_MS,
      }),
      candidate({
        url: "https://example.com/apple",
        title: "Same age apple story",
        sourceName: "hn",
        publishedAt: NOW - 2 * DAY_MS,
      }),
      candidate({
        url: "https://example.com/fresh",
        title: "Freshest story of them all",
        sourceName: "hn",
        publishedAt: NOW - HOUR_MS,
      }),
    ]);

    expect(clusters.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/fresh",
      "https://example.com/apple",
      "https://example.com/zebra",
    ]);
  });

  it("returns an empty array for no input", () => {
    expect(clusterCandidates([])).toEqual([]);
  });
});

describe("scoreClusters", () => {
  it("combines recency, popularity and corroboration into a 0..1 score", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/only",
          publishedAt: NOW - DAY_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
      ],
      { now: NOW, windowDays: 2 },
    );

    // 0.4 * recency(0.5) + 0.4 * popularity(1) + 0.2 * corroboration(0)
    expect(scored[0]!.score).toBeCloseTo(0.6, 6);
  });

  it("rewards a corroborated cluster over an otherwise identical solo one", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/solo",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/duo",
          publishedAt: NOW - HOUR_MS,
          members: [
            { sourceName: "hn", popularity: 100 },
            { sourceName: "lobsters", popularity: 5 },
          ],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    expect(scored[0]!.canonicalUrl).toBe("https://example.com/duo");
    expect(
      scoreOf(scored, "https://example.com/duo") -
        scoreOf(scored, "https://example.com/solo"),
    ).toBeCloseTo(0.1, 6);
  });

  it("saturates the corroboration bonus past three sources", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/trio",
          publishedAt: NOW - HOUR_MS,
          members: [
            { sourceName: "hn", popularity: 100 },
            { sourceName: "lobsters", popularity: 5 },
            { sourceName: "arxiv" },
          ],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/quartet",
          publishedAt: NOW - HOUR_MS,
          members: [
            { sourceName: "hn", popularity: 100 },
            { sourceName: "lobsters", popularity: 5 },
            { sourceName: "arxiv" },
            { sourceName: "rss:a.example.com" },
          ],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    expect(scoreOf(scored, "https://example.com/quartet")).toBe(
      scoreOf(scored, "https://example.com/trio"),
    );
  });

  it("ranks a recent cluster above an equivalent stale one in the window", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/stale",
          publishedAt: NOW - 3 * DAY_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/fresh",
          publishedAt: NOW - DAY_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
      ],
      { now: NOW, windowDays: 4 },
    );

    expect(scored.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/fresh",
      "https://example.com/stale",
    ]);
    expect(
      scoreOf(scored, "https://example.com/fresh") -
        scoreOf(scored, "https://example.com/stale"),
    ).toBeCloseTo(0.2, 6);
  });

  it("normalizes popularity per source so a Lobsters hit beats a mid-tier HN story", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/hn-top",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 2000 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/hn-mid",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 400 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/lobsters-top",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "lobsters", popularity: 20 }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    expect(scored.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/hn-top",
      "https://example.com/lobsters-top",
      "https://example.com/hn-mid",
    ]);
    expect(scoreOf(scored, "https://example.com/lobsters-top")).toBe(
      scoreOf(scored, "https://example.com/hn-top"),
    );
    expect(scoreOf(scored, "https://example.com/lobsters-top")).toBeGreaterThan(
      scoreOf(scored, "https://example.com/hn-mid"),
    );
  });

  it("compresses popularity logarithmically so a modest score still competes", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/hn-outlier",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 2000 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/hn-modest",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 50 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/arxiv-paper",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "arxiv" }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    // Linear normalization would put 50/2000 far below the 0.5 neutral baseline.
    expect(scoreOf(scored, "https://example.com/hn-modest")).toBeGreaterThan(
      scoreOf(scored, "https://example.com/arxiv-paper"),
    );
  });

  it("treats a vote-less source as average rather than worst", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/hn-top",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 2000 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/hn-small",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 20 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/arxiv-paper",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "arxiv" }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    expect(scoreOf(scored, "https://example.com/arxiv-paper")).toBeGreaterThan(
      scoreOf(scored, "https://example.com/hn-small"),
    );
    expect(scoreOf(scored, "https://example.com/arxiv-paper")).toBeLessThan(
      scoreOf(scored, "https://example.com/hn-top"),
    );
  });

  it("clamps recency for future timestamps and for items past the window", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/future",
          publishedAt: NOW + DAY_MS,
          members: [{ sourceName: "arxiv" }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/ancient",
          publishedAt: NOW - 90 * DAY_MS,
          members: [{ sourceName: "arxiv" }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    // 0.4 * 1 + 0.4 * 0.5 versus 0.4 * 0 + 0.4 * 0.5
    expect(scoreOf(scored, "https://example.com/future")).toBeCloseTo(0.6, 6);
    expect(scoreOf(scored, "https://example.com/ancient")).toBeCloseTo(0.2, 6);
  });

  it("breaks score ties by canonical URL", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/zzz",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/aaa",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 100 }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    expect(scored.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/aaa",
      "https://example.com/zzz",
    ]);
    expect(scored[0]!.score).toBe(scored[1]!.score);
  });

  it("is deterministic across repeated and reordered input", () => {
    const clusters = [
      makeCluster({
        canonicalUrl: "https://example.com/a",
        publishedAt: NOW - HOUR_MS,
        members: [{ sourceName: "hn", popularity: 900 }],
      }),
      makeCluster({
        canonicalUrl: "https://example.com/b",
        publishedAt: NOW - 2 * DAY_MS,
        members: [
          { sourceName: "hn", popularity: 90 },
          { sourceName: "lobsters", popularity: 40 },
        ],
      }),
      makeCluster({
        canonicalUrl: "https://example.com/c",
        publishedAt: NOW - 12 * HOUR_MS,
        members: [{ sourceName: "arxiv" }],
      }),
      makeCluster({
        canonicalUrl: "https://example.com/d",
        publishedAt: NOW - 12 * HOUR_MS,
        members: [{ sourceName: "rss:a.example.com" }],
      }),
    ];
    const opts = { now: NOW, windowDays: 7 };

    const first = scoreClusters(clusters, opts);
    const second = scoreClusters(clusters, opts);
    const reversed = scoreClusters([...clusters].reverse(), opts);

    const fingerprint = (scored: readonly ScoredCluster[]): string =>
      scored.map((c) => `${c.canonicalUrl}@${c.score}`).join("|");

    expect(fingerprint(second)).toBe(fingerprint(first));
    expect(fingerprint(reversed)).toBe(fingerprint(first));
    expect(clusters.map((c) => c.canonicalUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
      "https://example.com/d",
    ]);
  });

  it("rounds scores to six decimal places", () => {
    const scored = scoreClusters(
      [
        makeCluster({
          canonicalUrl: "https://example.com/hn-top",
          publishedAt: NOW - HOUR_MS,
          members: [{ sourceName: "hn", popularity: 2000 }],
        }),
        makeCluster({
          canonicalUrl: "https://example.com/hn-mid",
          publishedAt: NOW - 7 * HOUR_MS,
          members: [{ sourceName: "hn", popularity: 400 }],
        }),
      ],
      { now: NOW, windowDays: 3 },
    );

    for (const cluster of scored) {
      expect(decimalPlaces(cluster.score)).toBeLessThanOrEqual(6);
      expect(cluster.score).toBeGreaterThanOrEqual(0);
      expect(cluster.score).toBeLessThanOrEqual(1);
    }
  });

  it("never reads the wall clock", () => {
    const spy = vi.spyOn(Date, "now");
    try {
      const scored = scoreClusters(
        [
          makeCluster({
            canonicalUrl: "https://example.com/only",
            publishedAt: NOW - DAY_MS,
            members: [{ sourceName: "hn", popularity: 100 }],
          }),
        ],
        { now: NOW, windowDays: 2 },
      );
      expect(scored[0]!.score).toBeCloseTo(0.6, 6);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns an empty array for no clusters", () => {
    expect(scoreClusters([], { now: NOW, windowDays: 3 })).toEqual([]);
  });
});
