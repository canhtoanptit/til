import { describe, expect, it } from "vitest";
import { reviews } from "@til/db";
import {
  collectReportSnapshot,
  MAX_REPORT_ENTRIES,
  MAX_REPORT_TOP_ROWS,
  reportSkipReason,
  toReportSynthesisInputs,
  type ReportEntrySnapshot,
} from "./digest-report.js";
import { buildTestApp, insertEntry } from "./test-harness.js";
import type { Deps } from "./deps.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
// The plan's frozen instant, deliberately not `now()` so a leak of the wall clock
// into the window arithmetic is visible.
const RUN_AT = NOW - 3 * DAY;
const WINDOW = 30;

function app() {
  return buildTestApp({ now: () => NOW });
}

function collect(deps: Deps) {
  return collectReportSnapshot(deps, { runAt: RUN_AT, windowDays: WINDOW });
}

/** A save `daysAgo` before the run instant, not before `now()`. */
async function saved(
  deps: Deps,
  overrides: {
    id: string;
    daysAgo: number;
    status?: "pending" | "ready" | "failed";
    title?: string;
    takeaway?: string;
    tags?: string[];
    sourceDomain?: string;
  },
): Promise<void> {
  await insertEntry(deps.db, {
    id: overrides.id,
    url: `https://${overrides.sourceDomain ?? "example.com"}/${overrides.id}`,
    canonicalUrl: `https://${overrides.sourceDomain ?? "example.com"}/${overrides.id}`,
    title: overrides.title ?? `Entry ${overrides.id}`,
    takeaway: overrides.takeaway ?? `Takeaway ${overrides.id}`,
    tags: overrides.tags ?? [],
    sourceDomain: overrides.sourceDomain ?? "example.com",
    status: overrides.status ?? "ready",
    createdAt: RUN_AT - overrides.daysAgo * DAY,
  });
}

describe("collectReportSnapshot", () => {
  it("counts the month by status and pools only the entries it can write about", async () => {
    const t = app();
    await saved(t.deps, { id: "a", daysAgo: 1 });
    await saved(t.deps, { id: "b", daysAgo: 10 });
    await saved(t.deps, { id: "c", daysAgo: 20, status: "pending" });
    await saved(t.deps, { id: "d", daysAgo: 25, status: "failed" });

    const snapshot = await collect(t.deps);

    expect(snapshot.context).toMatchObject({
      saved: 4,
      ready: 2,
      pending: 1,
      failed: 1,
    });
    // Pending and failed entries have no takeaway to report on, so they are
    // counted but never shown to the model.
    expect(snapshot.entries.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("excludes entries saved outside the window, on both sides of the boundary", async () => {
    const t = app();
    await saved(t.deps, { id: "inside-edge", daysAgo: WINDOW });
    await saved(t.deps, { id: "inside", daysAgo: 5 });
    await saved(t.deps, { id: "too-old", daysAgo: WINDOW + 1 });
    // Saved after the run was planned: a later save must not leak into a report
    // about an earlier month via a replayed step.
    await saved(t.deps, { id: "way-old", daysAgo: 400 });

    const snapshot = await collect(t.deps);

    expect(snapshot.since).toBe(RUN_AT - WINDOW * DAY);
    expect(snapshot.entries.map((e) => e.id)).toEqual([
      "inside",
      "inside-edge",
    ]);
    expect(snapshot.context.saved).toBe(2);
  });

  it("uses the frozen runAt rather than deps.now() for the window", async () => {
    const t = app();
    // 20 days before `now()` but 17 before `runAt`: inside the window either way.
    await saved(t.deps, { id: "both", daysAgo: 17 });
    // 29 days before `runAt` is inside; 32 before `now()` would be outside. If the
    // window were measured from the wall clock this entry would vanish.
    await saved(t.deps, { id: "only-frozen", daysAgo: 29 });

    const snapshot = await collect(t.deps);
    expect(snapshot.entries.map((e) => e.id)).toEqual(["both", "only-frozen"]);
  });

  it("ranks top domains and top tags by count, ties broken alphabetically", async () => {
    const t = app();
    await saved(t.deps, {
      id: "r1",
      daysAgo: 1,
      sourceDomain: "rust-lang.org",
      tags: ["rust", "compilers"],
    });
    await saved(t.deps, {
      id: "r2",
      daysAgo: 2,
      sourceDomain: "rust-lang.org",
      tags: ["rust"],
    });
    await saved(t.deps, {
      id: "s1",
      daysAgo: 3,
      sourceDomain: "sqlite.org",
      tags: ["sqlite", "compilers"],
    });
    // Outside the window: must not appear in either aggregate.
    await saved(t.deps, {
      id: "old",
      daysAgo: WINDOW + 2,
      sourceDomain: "olddomain.example",
      tags: ["obsolete"],
    });

    const snapshot = await collect(t.deps);

    expect(snapshot.context.topDomains).toEqual([
      { domain: "rust-lang.org", count: 2 },
      { domain: "sqlite.org", count: 1 },
    ]);
    // Count descending, then tag ascending — the tie-break the chat `stats` tool
    // already uses, inherited rather than reimplemented.
    expect(snapshot.context.topTags).toEqual([
      { tag: "compilers", count: 2 },
      { tag: "rust", count: 2 },
      { tag: "sqlite", count: 1 },
    ]);
  });

  it("caps the domain and tag lists it puts in the prompt", async () => {
    const t = app();
    for (let i = 0; i < MAX_REPORT_TOP_ROWS + 4; i += 1) {
      await saved(t.deps, {
        id: `e${i}`,
        daysAgo: 1,
        sourceDomain: `d${i}.example`,
        tags: [`tag-${i}`],
      });
    }
    const snapshot = await collect(t.deps);
    expect(snapshot.context.topDomains).toHaveLength(MAX_REPORT_TOP_ROWS);
    expect(snapshot.context.topTags).toHaveLength(MAX_REPORT_TOP_ROWS);
    // The counts still cover everything, which is why the prompt is told the
    // aggregates separately from the list.
    expect(snapshot.context.saved).toBe(MAX_REPORT_TOP_ROWS + 4);
  });

  it("counts review cards graded inside the window and ignores older grades", async () => {
    const t = app();
    await saved(t.deps, { id: "a", daysAgo: 1 });
    await saved(t.deps, { id: "b", daysAgo: 2 });
    await saved(t.deps, { id: "c", daysAgo: 3 });
    await t.deps.db.insert(reviews).values([
      { entryId: "a", state: "review", reviewedAt: RUN_AT - 2 * DAY },
      { entryId: "b", state: "review", reviewedAt: RUN_AT - 29 * DAY },
      { entryId: "c", state: "review", reviewedAt: RUN_AT - 90 * DAY },
    ]);

    const snapshot = await collect(t.deps);
    expect(snapshot.context.reviewsGraded).toBe(2);
  });

  it("reports zero review activity when nothing was ever graded", async () => {
    const t = app();
    await saved(t.deps, { id: "a", daysAgo: 1 });
    await t.deps.db
      .insert(reviews)
      .values([{ entryId: "a", state: "new", reviewedAt: null }]);

    const snapshot = await collect(t.deps);
    expect(snapshot.context.reviewsGraded).toBe(0);
  });

  it("orders the pool most-recently-saved first and caps it", async () => {
    const t = app();
    await saved(t.deps, { id: "oldest", daysAgo: 20 });
    await saved(t.deps, { id: "newest", daysAgo: 1 });
    await saved(t.deps, { id: "middle", daysAgo: 10 });

    const snapshot = await collect(t.deps);
    expect(snapshot.entries.map((e) => e.id)).toEqual([
      "newest",
      "middle",
      "oldest",
    ]);
    expect(MAX_REPORT_ENTRIES).toBeGreaterThan(snapshot.entries.length);
  });

  it("returns an empty snapshot, not an error, for a month with no saves", async () => {
    const t = app();
    const snapshot = await collect(t.deps);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.context).toMatchObject({
      saved: 0,
      ready: 0,
      pending: 0,
      failed: 0,
      topDomains: [],
      topTags: [],
      reviewsGraded: 0,
    });
  });

  it("carries the fields the prompt renders, tags parsed from the JSON column", async () => {
    const t = app();
    await saved(t.deps, {
      id: "one",
      daysAgo: 4,
      title: "  Postgres index-only scans  ",
      takeaway: "Covering indexes skip the heap.",
      tags: ["postgres", "indexes"],
      sourceDomain: "pgblog.example",
    });

    const snapshot = await collect(t.deps);
    expect(snapshot.entries[0]).toEqual({
      id: "one",
      canonicalUrl: "https://pgblog.example/one",
      url: "https://pgblog.example/one",
      title: "Postgres index-only scans",
      sourceDomain: "pgblog.example",
      takeaway: "Covering indexes skip the heap.",
      tags: ["postgres", "indexes"],
      savedAt: RUN_AT - 4 * DAY,
    });
  });
});

describe("toReportSynthesisInputs", () => {
  function snapshot(
    overrides: Partial<ReportEntrySnapshot> = {},
  ): ReportEntrySnapshot {
    return {
      id: overrides.id ?? "e1",
      canonicalUrl: overrides.canonicalUrl ?? "https://example.com/e1",
      url: overrides.url ?? "https://example.com/e1",
      title: overrides.title ?? "A saved thing",
      sourceDomain: overrides.sourceDomain ?? "example.com",
      takeaway: overrides.takeaway ?? "The point of it.",
      tags: overrides.tags ?? ["alpha"],
      savedAt: overrides.savedAt ?? RUN_AT,
    };
  }

  it("maps saved-at onto publishedAt, takeaway onto snippet and domain onto sources", () => {
    const [input] = toReportSynthesisInputs([snapshot()]);
    expect(input).toEqual({
      canonicalUrl: "https://example.com/e1",
      title: "A saved thing",
      sources: ["example.com"],
      publishedAt: RUN_AT,
      snippet: "The point of it.",
      tags: ["alpha"],
    });
  });

  it("never invents a score — a report has no ranking to show", () => {
    const [input] = toReportSynthesisInputs([snapshot()]);
    expect(input && "score" in input).toBe(false);
  });

  it("omits empty optionals rather than sending blanks", () => {
    const [input] = toReportSynthesisInputs([
      snapshot({ takeaway: "   ", tags: [], sourceDomain: "" }),
    ]);
    expect(input).toEqual({
      canonicalUrl: "https://example.com/e1",
      title: "A saved thing",
      sources: [],
      publishedAt: RUN_AT,
    });
  });

  it("preserves order, since order is the only signal the model gets", () => {
    const inputs = toReportSynthesisInputs([
      snapshot({ id: "a", canonicalUrl: "https://example.com/a" }),
      snapshot({ id: "b", canonicalUrl: "https://example.com/b" }),
    ]);
    expect(inputs.map((i) => i.canonicalUrl)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });
});

describe("reportSkipReason", () => {
  const empty = {
    saved: 0,
    ready: 0,
    pending: 0,
    failed: 0,
    topDomains: [],
    topTags: [],
    reviewsGraded: 0,
  };

  it("is null whenever there is at least one entry to write about", () => {
    expect(
      reportSkipReason({
        since: 0,
        entries: [
          {
            id: "a",
            canonicalUrl: "https://example.com/a",
            url: "https://example.com/a",
            title: "A",
            sourceDomain: "example.com",
            takeaway: null,
            tags: [],
            savedAt: RUN_AT,
          },
        ],
        context: { ...empty, saved: 1, ready: 1 },
      }),
    ).toBeNull();
  });

  it("says nothing was saved when the month is genuinely empty", () => {
    const reason = reportSkipReason({ since: 0, entries: [], context: empty });
    expect(reason).toMatch(/no entries were saved/);
  });

  it("distinguishes 'saved but never processed' from 'saved nothing'", () => {
    const one = reportSkipReason({
      since: 0,
      entries: [],
      context: { ...empty, saved: 1, failed: 1 },
    });
    expect(one).toMatch(/1 entry was saved/);
    expect(one).toMatch(/none finished processing/);

    const many = reportSkipReason({
      since: 0,
      entries: [],
      context: { ...empty, saved: 3, pending: 3 },
    });
    expect(many).toMatch(/3 entries were saved/);
  });
});
