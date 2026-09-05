import { describe, expect, it } from "vitest";
import { entries, reviews } from "@til/db";
import { eq } from "drizzle-orm";
import { DAY_MS } from "@til/core";
import { buildTestApp, insertEntry } from "./test-harness.js";
import type {
  ReviewEnrollDTO,
  ReviewQueueDTO,
  ReviewScheduleDTO,
} from "./dto.js";

const NOW = 1_700_000_000_000;

type App = ReturnType<typeof buildTestApp>;

async function enroll(
  t: App,
  body: Record<string, unknown>,
): Promise<{ status: number; body: ReviewEnrollDTO }> {
  const res = await t.request("/api/reviews/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as ReviewEnrollDTO };
}

async function grade(
  t: App,
  entryId: string,
  value: unknown,
): Promise<{ status: number; body: ReviewScheduleDTO }> {
  const res = await t.request(`/api/reviews/${encodeURIComponent(entryId)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grade: value }),
  });
  return { status: res.status, body: (await res.json()) as ReviewScheduleDTO };
}

async function queue(t: App, query = ""): Promise<ReviewQueueDTO> {
  const res = await t.request(`/api/reviews/queue${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ReviewQueueDTO;
}

/** Enrolls a card and forces its schedule, bypassing the grade flow. */
async function seedCard(
  t: App,
  overrides: {
    entryId?: string;
    title?: string;
    question?: string;
    takeaway?: string;
    summary?: string;
    canonicalUrl?: string;
    state?: string;
    dueAt?: number | null;
    intervalDays?: number | null;
    ease?: number;
    lapses?: number;
  } = {},
): Promise<string> {
  const entryId = await insertEntry(t.deps.db, {
    ...(overrides.entryId === undefined ? {} : { id: overrides.entryId }),
    ...(overrides.title === undefined ? {} : { title: overrides.title }),
    ...(overrides.question === undefined
      ? {}
      : { question: overrides.question }),
    ...(overrides.takeaway === undefined
      ? {}
      : { takeaway: overrides.takeaway }),
    ...(overrides.summary === undefined ? {} : { summary: overrides.summary }),
    canonicalUrl:
      overrides.canonicalUrl ??
      `https://example.com/${overrides.entryId ?? crypto.randomUUID()}`,
  });
  await t.deps.db.insert(reviews).values({
    userId: "owner",
    entryId,
    state: overrides.state ?? "new",
    dueAt: overrides.dueAt === undefined ? NOW : overrides.dueAt,
    intervalDays: overrides.intervalDays ?? null,
    ease: overrides.ease ?? 2.5,
    lapses: overrides.lapses ?? 0,
  });
  return entryId;
}

describe("POST /api/reviews/enroll", () => {
  it("enrolls a single entry as a new card due now", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await insertEntry(t.deps.db, { id: "e-1" });

    const res = await enroll(t, { entryId: id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: 1, skipped: 0 });

    const rows = await t.deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.entryId, id));
    expect(rows[0]).toMatchObject({
      entryId: id,
      state: "new",
      dueAt: NOW,
      intervalDays: null,
      ease: 2.5,
      lapses: 0,
      lastGrade: null,
      reviewedAt: null,
    });
  });

  it("is a no-op — not a reset — for an already enrolled entry", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, {
      entryId: "e-mid-flight",
      state: "review",
      dueAt: NOW + 12 * DAY_MS,
      intervalDays: 12,
      ease: 2.05,
      lapses: 3,
    });

    const res = await enroll(t, { entryId: id });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: 0, skipped: 1 });

    const rows = await t.deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.entryId, id));
    expect(rows[0]).toMatchObject({
      state: "review",
      dueAt: NOW + 12 * DAY_MS,
      intervalDays: 12,
      lapses: 3,
    });
    expect(rows[0]?.ease).toBeCloseTo(2.05);
  });

  it("404s for an entry that does not exist", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/reviews/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entryId: "nope" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("all: true enrols every ready entry and skips the ones already enrolled", async () => {
    const t = buildTestApp({ now: () => NOW });
    const already = await seedCard(t, {
      entryId: "e-already",
      state: "review",
      dueAt: NOW + 5 * DAY_MS,
      intervalDays: 5,
    });
    await insertEntry(t.deps.db, {
      id: "e-ready-1",
      canonicalUrl: "https://example.com/1",
    });
    await insertEntry(t.deps.db, {
      id: "e-ready-2",
      canonicalUrl: "https://example.com/2",
    });
    await insertEntry(t.deps.db, {
      id: "e-pending",
      canonicalUrl: "https://example.com/3",
      status: "pending",
    });
    await insertEntry(t.deps.db, {
      id: "e-failed",
      canonicalUrl: "https://example.com/4",
      status: "failed",
    });

    const res = await enroll(t, { all: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enrolled: 2, skipped: 1 });

    const all = await t.deps.db.select().from(reviews);
    expect(all.map((r) => r.entryId).sort()).toEqual([
      "e-already",
      "e-ready-1",
      "e-ready-2",
    ]);
    // The pre-existing card kept its schedule.
    const kept = all.find((r) => r.entryId === already);
    expect(kept).toMatchObject({ state: "review", intervalDays: 5 });
  });

  it("all: true is idempotent when run twice", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "a",
      canonicalUrl: "https://example.com/a",
    });
    await insertEntry(t.deps.db, {
      id: "b",
      canonicalUrl: "https://example.com/b",
    });

    const first = await enroll(t, { all: true });
    expect(first.body).toEqual({ enrolled: 2, skipped: 0 });
    const second = await enroll(t, { all: true });
    expect(second.body).toEqual({ enrolled: 0, skipped: 2 });
    expect(await t.deps.db.select().from(reviews)).toHaveLength(2);
  });

  it("enrols past the D1 parameter batch limit", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < 25; i += 1) {
      await insertEntry(t.deps.db, {
        id: `bulk-${i}`,
        canonicalUrl: `https://example.com/bulk-${i}`,
      });
    }
    const res = await enroll(t, { all: true });
    expect(res.body).toEqual({ enrolled: 25, skipped: 0 });
    expect(await t.deps.db.select().from(reviews)).toHaveLength(25);
  });

  it("rejects a body with both or neither shape → 422", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (const body of [{}, { all: true, entryId: "x" }, { all: false }]) {
      const res = await t.request("/api/reviews/enroll", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(422);
      expect((await res.json()) as { error: { code: string } }).toMatchObject({
        error: { code: "validation_error" },
      });
    }
  });

  it("requires the bearer token", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/reviews/enroll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ all: true }),
      auth: false,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/reviews/queue", () => {
  it("returns the most overdue card first", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedCard(t, {
      entryId: "c-soon",
      state: "review",
      dueAt: NOW - 1_000,
      intervalDays: 4,
    });
    await seedCard(t, {
      entryId: "c-ancient",
      state: "review",
      dueAt: NOW - 40 * DAY_MS,
      intervalDays: 9,
    });
    await seedCard(t, {
      entryId: "c-mid",
      state: "review",
      dueAt: NOW - 2 * DAY_MS,
      intervalDays: 6,
    });

    const body = await queue(t);
    expect(body.items.map((i) => i.entryId)).toEqual([
      "c-ancient",
      "c-mid",
      "c-soon",
    ]);
    expect(body.dueCount).toBe(3);
  });

  it("omits cards that are not due yet", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedCard(t, { entryId: "due-now", dueAt: NOW });
    await seedCard(t, {
      entryId: "due-later",
      state: "review",
      dueAt: NOW + 1,
      intervalDays: 3,
    });

    const body = await queue(t);
    expect(body.items.map((i) => i.entryId)).toEqual(["due-now"]);
    expect(body.dueCount).toBe(1);
  });

  it("treats a card with no dueAt as due", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedCard(t, { entryId: "never-scheduled", dueAt: null });
    const body = await queue(t);
    expect(body.items.map((i) => i.entryId)).toEqual(["never-scheduled"]);
    expect(body.dueCount).toBe(1);
  });

  it("honours limit but still counts every due card", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < 5; i += 1) {
      await seedCard(t, {
        entryId: `q-${i}`,
        state: "review",
        dueAt: NOW - (5 - i) * DAY_MS,
        intervalDays: 4,
      });
    }
    const body = await queue(t, "?limit=2");
    expect(body.items.map((i) => i.entryId)).toEqual(["q-0", "q-1"]);
    expect(body.dueCount).toBe(5);
  });

  it("counts every enrolled card, due or not, separately from dueCount", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedCard(t, { entryId: "due-1" });
    await seedCard(t, { entryId: "due-2" });
    await seedCard(t, {
      entryId: "not-due",
      state: "review",
      dueAt: NOW + 10 * DAY_MS,
      intervalDays: 10,
    });

    const body = await queue(t);
    // The distinction the empty state depends on: 2 due, but 3 enrolled — so an
    // empty queue here would mean "caught up", never "never started".
    expect(body.dueCount).toBe(2);
    expect(body.enrolledCount).toBe(3);
  });

  it("reports enrolledCount 0 only when nothing has ever been enrolled", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, { id: "saved-not-enrolled" });
    expect((await queue(t)).enrolledCount).toBe(0);

    await enroll(t, { entryId: "saved-not-enrolled" });
    expect((await queue(t)).enrolledCount).toBe(1);

    // Grading does not un-enroll: the card leaves the due queue, not the library.
    await grade(t, "saved-not-enrolled", 4);
    const after = await queue(t);
    expect(after.dueCount).toBe(0);
    expect(after.enrolledCount).toBe(1);
  });

  it("clamps a nonsense limit instead of failing", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < 12; i += 1) {
      await seedCard(t, {
        entryId: `l-${i}`,
        canonicalUrl: `https://example.com/l-${i}`,
      });
    }
    expect((await queue(t, "?limit=0")).items).toHaveLength(1);
    expect((await queue(t, "?limit=abc")).items).toHaveLength(10);
    expect((await queue(t, "?limit=999")).items).toHaveLength(12);
  });

  it("is empty, with a zero count, when nothing is enrolled", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, { id: "unenrolled" });
    const body = await queue(t);
    // Exact shape, so a future field has to be added here deliberately.
    expect(body).toEqual({ items: [], dueCount: 0, enrolledCount: 0 });
  });

  it("breaks dueAt ties deterministically by entryId", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (const id of ["tie-c", "tie-a", "tie-b"]) {
      await seedCard(t, { entryId: id, dueAt: NOW - 1 });
    }
    expect((await queue(t)).items.map((i) => i.entryId)).toEqual([
      "tie-a",
      "tie-b",
      "tie-c",
    ]);
  });

  it("requires the bearer token", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/reviews/queue", { auth: false });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/reviews/queue — the answer never rides along", () => {
  const ANSWER = "The borrow checker rejects aliased mutable references";
  const SUMMARY = "A long summary that would spoil the card entirely.";

  it("carries the question side only, whatever the entry holds", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedCard(t, {
      entryId: "leak-check",
      title: "Rust ownership deep dive",
      question: "What does the borrow checker prevent?",
      takeaway: ANSWER,
      summary: SUMMARY,
    });

    const res = await t.request("/api/reviews/queue");
    const raw = await res.text();

    // Property: no answer-bearing field appears anywhere in the payload, at any
    // nesting depth — checked on the wire text, not on a parsed shape, so a future
    // nested DTO cannot smuggle one past this test.
    expect(raw).not.toContain(ANSWER);
    expect(raw).not.toContain(SUMMARY);
    expect(raw).not.toMatch(/takeaway/i);
    expect(raw).not.toMatch(/summary/i);
    expect(raw).not.toMatch(/contentMarkdown|content_markdown/i);
    expect(raw).not.toMatch(/\btags\b/i);

    const body = JSON.parse(raw) as ReviewQueueDTO;
    const item = body.items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "dueAt",
      "ease",
      "entryId",
      "intervalDays",
      "lapses",
      "question",
      "sourceDomain",
      "state",
      "title",
      "url",
    ]);
    expect(item?.title).toBe("Rust ownership deep dive");
    expect(item?.question).toBe("What does the borrow checker prevent?");
  });

  it("still surfaces the card when the entry has no question at all", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await insertEntry(t.deps.db, { id: "no-question" });
    await t.deps.db
      .update(entries)
      .set({ question: null, title: null })
      .where(eq(entries.id, id));
    await enroll(t, { entryId: id });

    const body = await queue(t);
    expect(body.items[0]).toMatchObject({
      entryId: id,
      title: null,
      question: null,
    });
  });
});

describe("POST /api/reviews/:entryId", () => {
  it("walks a new card up the ladder on Good", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, { entryId: "walk" });

    const first = await grade(t, id, 3);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      entryId: id,
      state: "learning",
      intervalDays: 1,
      lapses: 0,
      lastGrade: 3,
      reviewedAt: NOW,
      dueAt: NOW + DAY_MS,
    });

    const second = await grade(t, id, 3);
    expect(second.body).toMatchObject({
      state: "learning",
      intervalDays: 3,
      dueAt: NOW + 3 * DAY_MS,
    });

    const third = await grade(t, id, 3);
    expect(third.body).toMatchObject({
      state: "review",
      intervalDays: 8,
      dueAt: NOW + 8 * DAY_MS,
    });

    const rows = await t.deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.entryId, id));
    expect(rows[0]).toMatchObject({
      state: "review",
      intervalDays: 8,
      lastGrade: 3,
      reviewedAt: NOW,
      lapses: 0,
    });
  });

  it("Again relearns at one day, drops ease and counts a lapse", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, {
      entryId: "lapse",
      state: "review",
      dueAt: NOW - DAY_MS,
      intervalDays: 30,
      ease: 2.5,
      lapses: 1,
    });

    const res = await grade(t, id, 1);
    expect(res.body).toMatchObject({
      state: "learning",
      intervalDays: 1,
      lapses: 2,
      lastGrade: 1,
      dueAt: NOW + DAY_MS,
    });
    expect(res.body.ease).toBeCloseTo(2.3);
  });

  it("Hard, Good and Easy stretch a review card by increasing amounts", async () => {
    const t = buildTestApp({ now: () => NOW });
    const intervals: number[] = [];
    for (const [grade_, id] of [
      [2, "h"],
      [3, "g"],
      [4, "e"],
    ] as const) {
      const entryId = await seedCard(t, {
        entryId: id,
        state: "review",
        dueAt: NOW - DAY_MS,
        intervalDays: 10,
      });
      const res = await grade(t, entryId, grade_);
      intervals.push(res.body.intervalDays ?? 0);
    }
    expect(intervals).toEqual([12, 25, 34]);
    expect(intervals[0]).toBeLessThan(intervals[1] ?? 0);
    expect(intervals[1]).toBeLessThan(intervals[2] ?? 0);
  });

  it("drops a graded card out of the queue and off the due count", async () => {
    const t = buildTestApp({ now: () => NOW });
    const graded = await seedCard(t, { entryId: "graded" });
    await seedCard(t, { entryId: "untouched" });

    expect((await queue(t)).dueCount).toBe(2);
    await grade(t, graded, 3);
    const after = await queue(t);
    expect(after.items.map((i) => i.entryId)).toEqual(["untouched"]);
    expect(after.dueCount).toBe(1);
  });

  it("404s for an entry that is not enrolled", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await insertEntry(t.deps.db, { id: "not-enrolled" });
    const res = await t.request(`/api/reviews/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grade: 3 }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: { code: string } }).toMatchObject({
      error: { code: "not_found" },
    });
  });

  it("rejects grades outside 1-4 and non-integers → 422", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, { entryId: "bad-grade" });
    for (const bad of [0, 5, -1, 2.5, "3", null]) {
      const res = await t.request(`/api/reviews/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ grade: bad }),
      });
      expect(res.status).toBe(422);
    }
    const rows = await t.deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.entryId, id));
    expect(rows[0]).toMatchObject({ state: "new", lastGrade: null });
  });

  it("requires the bearer token", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, { entryId: "auth" });
    const res = await t.request(`/api/reviews/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ grade: 3 }),
      auth: false,
    });
    expect(res.status).toBe(401);
  });
});

describe("reviews schema, against the real migration", () => {
  it("applies the column defaults from 0007", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await insertEntry(t.deps.db, { id: "defaults" });
    // Omit every defaulted column so SQLite, not drizzle, supplies the values.
    await t.deps.db.insert(reviews).values({ userId: "owner", entryId: id });
    const rows = await t.deps.db
      .select()
      .from(reviews)
      .where(eq(reviews.entryId, id));
    expect(rows[0]).toMatchObject({
      state: "new",
      ease: 2.5,
      lapses: 0,
      dueAt: null,
      intervalDays: null,
      lastGrade: null,
      reviewedAt: null,
    });
  });

  it("cascades the card away when its entry is deleted", async () => {
    const t = buildTestApp({ now: () => NOW });
    const doomed = await seedCard(t, { entryId: "doomed" });
    const kept = await seedCard(t, { entryId: "kept" });

    const res = await t.request(`/api/entries/${doomed}`, { method: "DELETE" });
    expect(res.status).toBe(204);

    const remaining = await t.deps.db.select().from(reviews);
    expect(remaining.map((r) => r.entryId)).toEqual([kept]);
    const after = await queue(t);
    expect(after.dueCount).toBe(1);
    // The cascade takes the card off the enrolled count too — otherwise deleting
    // your way back to an empty library would still claim you had enrolled cards.
    expect(after.enrolledCount).toBe(1);
  });

  it("rejects a card for an entry that does not exist", async () => {
    const t = buildTestApp({ now: () => NOW });
    await expect(
      t.deps.db.insert(reviews).values({ userId: "owner", entryId: "ghost" }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("keeps one card per entry", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await seedCard(t, { entryId: "solo" });
    await expect(
      t.deps.db.insert(reviews).values({ userId: "owner", entryId: id }),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });
});
