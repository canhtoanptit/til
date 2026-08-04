import { describe, expect, it, vi } from "vitest";
import type { Embedder } from "@til/core";
import type { Deps } from "./deps.js";
import { indexEntry } from "./indexing.js";
import {
  clampTopK,
  getEntryForTool,
  isoWeek,
  searchEntries,
  stats,
} from "./retrieval.js";
import {
  buildTestApp,
  insertEntry,
  makeStubEmbedder,
  makeThrowingEmbedder,
} from "./test-harness.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

// Axis 0 = memory safety, axis 1 = databases, axis 2 = kubernetes.
const TOPICS = [
  ["ownership", "borrow", "memory safety", "rust"],
  ["sqlite", "index", "query planner", "database"],
  ["kubernetes", "pods", "scheduler", "cluster"],
];

function embedder(onEmbed?: (texts: string[]) => void): Embedder {
  return makeStubEmbedder(TOPICS, {
    dimensions: 8,
    ...(onEmbed ? { onEmbed } : {}),
  });
}

interface SeedOptions {
  embedder?: Embedder | null;
  now?: number;
}

/**
 * Two entries chosen so each is reachable by exactly one leg: `semantic-only`
 * shares no query keyword but sits on the same topic axis, `keyword-only` shares
 * a rare literal token but no topic.
 */
async function seedCorpus(opts: SeedOptions = {}) {
  const now = opts.now ?? NOW;
  const t = buildTestApp({
    now: () => now,
    embedder: opts.embedder === undefined ? embedder() : opts.embedder,
  });

  const rows = [
    {
      id: "semantic-only",
      title: "Ownership and the borrow checker",
      summary: "How the compiler proves memory safety without a collector.",
      takeaway: "One owner per value, checked at compile time.",
      tags: ["rust", "memory-safety"],
      sourceDomain: "rust-lang.org",
      createdAt: now - 2 * DAY,
    },
    {
      id: "keyword-only",
      title: "Notes on the zygohistomorphic prepromorphism",
      summary: "A recursion scheme with an unhelpfully long name.",
      takeaway: "Mostly a joke, occasionally useful.",
      tags: ["haskell"],
      sourceDomain: "wiki.haskell.org",
      createdAt: now - 3 * DAY,
    },
    {
      id: "db-1",
      title: "How the SQLite query planner picks an index",
      summary: "Reading EXPLAIN QUERY PLAN output for a database.",
      takeaway: "Covering indexes avoid the table lookup entirely.",
      tags: ["sqlite", "databases"],
      sourceDomain: "sqlite.org",
      createdAt: now - 10 * DAY,
    },
    {
      id: "k8s-1",
      title: "Kubernetes scheduler internals",
      summary: "How pods are placed on nodes in a cluster.",
      takeaway: "Scoring plugins decide the final node.",
      tags: ["kubernetes"],
      sourceDomain: "kubernetes.io",
      createdAt: now - 40 * DAY,
    },
  ];

  for (const row of rows) {
    await insertEntry(t.deps.db, {
      id: row.id,
      url: `https://${row.sourceDomain}/${row.id}`,
      canonicalUrl: `https://${row.sourceDomain}/${row.id}`,
      title: row.title,
      summary: row.summary,
      takeaway: row.takeaway,
      question: "And then?",
      tags: row.tags,
      sourceDomain: row.sourceDomain,
      createdAt: row.createdAt,
    });
    await indexEntry(t.deps, {
      id: row.id,
      title: row.title,
      summary: row.summary,
      takeaway: row.takeaway,
      tags: row.tags,
      sourceDomain: row.sourceDomain,
      createdAt: row.createdAt,
    });
  }

  return t;
}

describe("clampTopK", () => {
  it("defaults to 8 and caps at 20", () => {
    expect(clampTopK(undefined)).toBe(8);
    expect(clampTopK(Number.NaN)).toBe(8);
    expect(clampTopK(0)).toBe(1);
    expect(clampTopK(-4)).toBe(1);
    expect(clampTopK(5)).toBe(5);
    expect(clampTopK(999)).toBe(20);
  });
});

describe("searchEntries (hybrid)", () => {
  it("surfaces both a semantic-only and a keyword-only match", async () => {
    const t = await seedCorpus();
    // "ownership memory safety" shares no literal token with the semantic-only
    // entry's rare words, and "zygohistomorphic" is on no topic axis.
    const out = await searchEntries(t.deps, {
      query: "zygohistomorphic ownership memory safety",
      topK: 8,
    });
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain("semantic-only");
    expect(ids).toContain("keyword-only");
  });

  it("finds a purely semantic match with no shared keyword at all", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, {
      query: "kubernetes",
      topK: 3,
    });
    expect(out.items.map((i) => i.id)).toContain("k8s-1");
  });

  it("respects topK", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, {
      query: "index database kubernetes ownership",
      topK: 2,
    });
    expect(out.items).toHaveLength(2);
  });

  it("returns the contract item shape with a fused score", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, { query: "sqlite index", topK: 1 });
    const item = out.items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "score",
      "sourceDomain",
      "tags",
      "takeaway",
      "title",
      "url",
    ]);
    expect(item?.score).toBeGreaterThan(0);
    expect(item?.tags).toEqual(["sqlite", "databases"]);
  });

  it("filters by tag", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, {
      query: "index database ownership kubernetes",
      topK: 10,
      tag: "sqlite",
    });
    expect(out.items.map((i) => i.id)).toEqual(["db-1"]);
  });

  it("does not let a tag filter match a longer tag by prefix", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, {
      query: "ownership memory safety",
      topK: 10,
      tag: "memory",
    });
    expect(out.items).toEqual([]);
  });

  it("filters by sinceDays", async () => {
    const t = await seedCorpus();
    const out = await searchEntries(t.deps, {
      query: "index database ownership kubernetes scheduler",
      topK: 10,
      sinceDays: 7,
    });
    const ids = out.items.map((i) => i.id);
    expect(ids).toContain("semantic-only");
    expect(ids).not.toContain("db-1");
    expect(ids).not.toContain("k8s-1");
  });

  it("returns nothing for a blank query", async () => {
    const t = await seedCorpus();
    await expect(searchEntries(t.deps, { query: "   " })).resolves.toEqual({
      items: [],
    });
  });

  it("degrades to FTS-only when the embedder throws", async () => {
    const t = await seedCorpus({ embedder: makeThrowingEmbedder() });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const out = await searchEntries(t.deps, {
      query: "zygohistomorphic",
      topK: 8,
    });
    warn.mockRestore();
    expect(out.items.map((i) => i.id)).toEqual(["keyword-only"]);
  });

  it("degrades to FTS-only when there is no embedder at all", async () => {
    const t = await seedCorpus({ embedder: null });
    const out = await searchEntries(t.deps, { query: "sqlite", topK: 8 });
    expect(out.items.map((i) => i.id)).toEqual(["db-1"]);
  });

  it("still embeds the query only once per search", async () => {
    const calls: string[][] = [];
    const t = await seedCorpus({
      embedder: embedder((texts) => calls.push(texts)),
    });
    const before = calls.length;
    await searchEntries(t.deps, { query: "sqlite index", topK: 5 });
    expect(calls.length - before).toBe(1);
  });
});

describe("getEntryForTool", () => {
  it("returns the digest fields and omits contentMarkdown", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "e-1",
      title: "T",
      summary: "S",
      takeaway: "K",
      question: "Q",
      tags: ["a", "b"],
      createdAt: NOW,
    });
    const { entries } = await import("@til/db");
    const { eq } = await import("drizzle-orm");
    await t.deps.db
      .update(entries)
      .set({ contentMarkdown: "the whole article".repeat(500) })
      .where(eq(entries.id, "e-1"));

    const out = await getEntryForTool(t.deps, { id: "e-1" });
    expect(out).not.toBeNull();
    expect(Object.keys(out ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "question",
      "summary",
      "tags",
      "takeaway",
      "title",
      "url",
    ]);
    expect(JSON.stringify(out)).not.toContain("the whole article");
    expect(out?.tags).toEqual(["a", "b"]);
  });

  it("returns null for an unknown id", async () => {
    const t = buildTestApp();
    await expect(getEntryForTool(t.deps, { id: "nope" })).resolves.toBeNull();
  });
});

describe("stats", () => {
  async function seedStats(): Promise<Deps> {
    const t = buildTestApp({ now: () => NOW });
    const rows: {
      id: string;
      createdAt: number;
      tags: string[];
      domain: string;
    }[] = [
      { id: "s1", createdAt: NOW, tags: ["rust", "wasm"], domain: "a.com" },
      { id: "s2", createdAt: NOW - DAY, tags: ["rust"], domain: "a.com" },
      { id: "s3", createdAt: NOW - 2 * DAY, tags: ["rust"], domain: "b.com" },
      { id: "s4", createdAt: NOW - 20 * DAY, tags: ["wasm"], domain: "c.com" },
    ];
    for (const row of rows) {
      await insertEntry(t.deps.db, {
        id: row.id,
        url: `https://${row.domain}/${row.id}`,
        canonicalUrl: `https://${row.domain}/${row.id}`,
        tags: row.tags,
        sourceDomain: row.domain,
        createdAt: row.createdAt,
      });
    }
    await insertEntry(t.deps.db, {
      id: "s5",
      url: "https://a.com/pending",
      canonicalUrl: "https://a.com/pending",
      status: "pending",
      tags: [],
      sourceDomain: "a.com",
      createdAt: NOW,
    });
    return t.deps;
  }

  it("totals counts every entry and breaks it down by status", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "totals" });
    expect(out.kind).toBe("totals");
    // WHY this assertion exists: the M2 trap was a correlated raw count(*)
    // silently returning 0, so a real non-zero total is the regression guard.
    expect(out.rows).toEqual([{ entries: 5, ready: 4, pending: 1, failed: 0 }]);
  });

  it("totals honours sinceDays", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "totals", sinceDays: 7 });
    expect(out.rows[0]).toMatchObject({ entries: 4, ready: 3, pending: 1 });
  });

  it("per_week buckets by ISO week, newest first", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "per_week" });
    expect(out.kind).toBe("per_week");
    expect(out.rows.length).toBeGreaterThanOrEqual(2);
    const weeks = out.rows.map((r) => String(r.week));
    expect(weeks).toEqual([...weeks].sort().reverse());
    const total = out.rows.reduce((sum, r) => sum + Number(r.count), 0);
    expect(total).toBe(5);
    expect(weeks[0]).toBe(isoWeek(NOW));
  });

  it("top_tags expands the JSON tags column and ranks by count", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "top_tags" });
    expect(out.rows).toEqual([
      { tag: "rust", count: 3 },
      { tag: "wasm", count: 2 },
    ]);
  });

  it("top_domains groups without the unqualified-count trap", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "top_domains" });
    expect(out.rows).toEqual([
      { domain: "a.com", count: 3 },
      { domain: "b.com", count: 1 },
      { domain: "c.com", count: 1 },
    ]);
  });

  it("streak counts consecutive days up to today", async () => {
    const deps = await seedStats();
    const out = await stats(deps, { kind: "streak" });
    const row = out.rows[0];
    expect(row).toMatchObject({
      currentDays: 3,
      longestDays: 3,
      activeDays: 4,
    });
    expect(String(row?.lastSavedOn)).toBe("2026-08-04");
  });

  it("streak is zero once the run is broken", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "old",
      canonicalUrl: "https://a.com/old",
      createdAt: NOW - 30 * DAY,
    });
    const out = await stats(t.deps, { kind: "streak" });
    expect(out.rows[0]).toMatchObject({ currentDays: 0, longestDays: 1 });
  });

  it("returns an empty-but-shaped streak row for an empty corpus", async () => {
    const t = buildTestApp({ now: () => NOW });
    const out = await stats(t.deps, { kind: "streak" });
    expect(out.rows).toEqual([
      { currentDays: 0, longestDays: 0, activeDays: 0, lastSavedOn: "" },
    ]);
  });

  it("returns empty rows for aggregates over an empty corpus", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (const kind of ["per_week", "top_tags", "top_domains"] as const) {
      const out = await stats(t.deps, { kind });
      expect(out).toEqual({ kind, rows: [] });
    }
  });
});

describe("isoWeek", () => {
  it("labels weeks in ISO-8601 form", () => {
    expect(isoWeek(Date.UTC(2026, 0, 1))).toBe("2026-W01");
    expect(isoWeek(Date.UTC(2026, 7, 4))).toBe("2026-W32");
  });

  it("assigns a January date to the previous ISO year when it belongs there", () => {
    // 2027-01-01 is a Friday, so it falls in ISO week 53 of 2026.
    expect(isoWeek(Date.UTC(2027, 0, 1))).toBe("2026-W53");
  });
});
