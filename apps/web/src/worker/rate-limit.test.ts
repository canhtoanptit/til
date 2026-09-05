import { describe, expect, it } from "vitest";
import { entries } from "@til/db";
import {
  DAILY_ENTRY_LIMIT,
  resolveDailyEntryLimit,
  utcDayStart,
} from "./routes/entries.js";
import type { TestApp } from "./test-harness.js";
import { buildTestApp, insertSettings } from "./test-harness.js";

/** The harness clock. Mid-afternoon UTC on 2023-11-14 — deliberately not a
 *  midnight, so `retry-after` is a non-trivial number the tests can derive. */
const PINNED_NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The route's own formula, restated once here so a test never hardcodes a
 *  magic second count that would silently stop matching the clock. */
function expectedRetryAfter(nowMs: number): number {
  return Math.max(1, Math.ceil((utcDayStart(nowMs) + DAY_MS - nowMs) / 1000));
}

function save(t: TestApp, url: string, user?: string) {
  return t.request("/api/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
    ...(user === undefined ? {} : { user }),
  });
}

interface LimitBody {
  error: { code: string; message: string };
  retryAfterSeconds: number;
}

/**
 * A BYOK row for whoever is saving. The limiter does not care, but the
 * fire-and-forget ingest each 201 schedules does: without settings every save
 * ends in a logged "settings not configured" failure, which buries the actual
 * assertions in noise.
 */
async function seedSettings(t: TestApp, ...userIds: string[]): Promise<void> {
  if (userIds.length === 0) {
    await insertSettings(t.deps.db);
    return;
  }
  for (const userId of userIds) await insertSettings(t.deps.db, { userId });
}

describe("resolveDailyEntryLimit", () => {
  it("falls back to the built-in cap when the var is unset", () => {
    expect(resolveDailyEntryLimit(undefined)).toBe(DAILY_ENTRY_LIMIT);
    expect(resolveDailyEntryLimit("")).toBe(DAILY_ENTRY_LIMIT);
  });

  it("accepts a positive integer", () => {
    expect(resolveDailyEntryLimit("2")).toBe(2);
    expect(resolveDailyEntryLimit("250")).toBe(250);
    // parseInt tolerates surrounding whitespace, which a copy-pasted secret has.
    expect(resolveDailyEntryLimit(" 7 ")).toBe(7);
  });

  it("falls back on zero, negatives and garbage", () => {
    expect(resolveDailyEntryLimit("0")).toBe(DAILY_ENTRY_LIMIT);
    expect(resolveDailyEntryLimit("-3")).toBe(DAILY_ENTRY_LIMIT);
    expect(resolveDailyEntryLimit("abc")).toBe(DAILY_ENTRY_LIMIT);
    expect(resolveDailyEntryLimit("1e9")).toBe(1); // parseInt stops at the "e"
  });
});

describe("utcDayStart", () => {
  it("floors an epoch-ms instant to its UTC midnight", () => {
    expect(utcDayStart(0)).toBe(0);
    const midnight = utcDayStart(PINNED_NOW);
    expect(midnight % DAY_MS).toBe(0);
    // Exact midnight is its own day start; one millisecond earlier belongs to
    // the previous day — the boundary the daily counter turns on.
    expect(utcDayStart(midnight)).toBe(midnight);
    expect(utcDayStart(midnight - 1)).toBe(midnight - DAY_MS);
    expect(new Date(midnight).toISOString()).toBe("2023-11-14T00:00:00.000Z");
  });
});

describe("POST /api/entries — daily limit", () => {
  it("allows ten saves a day and refuses the eleventh with 429", async () => {
    const t = buildTestApp({ now: () => PINNED_NOW });
    await seedSettings(t);

    for (let i = 0; i < DAILY_ENTRY_LIMIT; i += 1) {
      const ok = await save(t, `https://example.com/day-${i}`);
      expect(ok.status).toBe(201);
    }

    const res = await save(t, "https://example.com/one-too-many");
    expect(res.status).toBe(429);
    const body = (await res.json()) as LimitBody;
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.message).toBe("Daily entry limit reached (10/day).");

    const retryAfter = expectedRetryAfter(PINNED_NOW);
    expect(body.retryAfterSeconds).toBe(retryAfter);
    expect(res.headers.get("retry-after")).toBe(String(retryAfter));

    // The refusal is a refusal: nothing was written.
    const rows = await t.deps.db.select({ id: entries.id }).from(entries);
    expect(rows).toHaveLength(DAILY_ENTRY_LIMIT);
    await t.flush();
  });

  it("counts per user — one tenant at the cap does not block another", async () => {
    // The cap value is irrelevant to what this asserts, so the override keeps
    // it to three requests instead of twenty-one.
    const t = buildTestApp({
      now: () => PINNED_NOW,
      env: { ENTRY_DAILY_LIMIT: "2" },
    });
    await seedSettings(t, "alice", "bob");

    expect((await save(t, "https://example.com/a1", "alice")).status).toBe(201);
    expect((await save(t, "https://example.com/a2", "alice")).status).toBe(201);
    expect((await save(t, "https://example.com/a3", "alice")).status).toBe(429);

    // Same URLs, even: uniqueness is per-user too, so bob is starting clean.
    expect((await save(t, "https://example.com/a1", "bob")).status).toBe(201);
    expect((await save(t, "https://example.com/a2", "bob")).status).toBe(201);
    expect((await save(t, "https://example.com/a3", "bob")).status).toBe(429);
    await t.flush();
  });

  it("resets at UTC midnight, not a millisecond earlier", async () => {
    let clock = PINNED_NOW;
    const t = buildTestApp({
      now: () => clock,
      env: { ENTRY_DAILY_LIMIT: "2" },
    });
    await seedSettings(t);

    expect((await save(t, "https://example.com/r1")).status).toBe(201);
    expect((await save(t, "https://example.com/r2")).status).toBe(201);
    expect((await save(t, "https://example.com/r3")).status).toBe(429);

    const nextMidnight = utcDayStart(PINNED_NOW) + DAY_MS;
    clock = nextMidnight - 1;
    expect((await save(t, "https://example.com/r3")).status).toBe(429);

    clock = nextMidnight;
    expect((await save(t, "https://example.com/r3")).status).toBe(201);
    await t.flush();
  });

  it("honours ENTRY_DAILY_LIMIT and reports it in the message", async () => {
    const t = buildTestApp({
      now: () => PINNED_NOW,
      env: { ENTRY_DAILY_LIMIT: "2" },
    });
    await seedSettings(t);

    expect((await save(t, "https://example.com/e1")).status).toBe(201);
    expect((await save(t, "https://example.com/e2")).status).toBe(201);
    const res = await save(t, "https://example.com/e3");
    expect(res.status).toBe(429);
    const body = (await res.json()) as LimitBody;
    expect(body.error.message).toBe("Daily entry limit reached (2/day).");
    await t.flush();
  });

  it.each(["0", "-3", "abc"])(
    "ignores a nonsense ENTRY_DAILY_LIMIT of %j and keeps the default",
    async (raw) => {
      const t = buildTestApp({
        now: () => PINNED_NOW,
        env: { ENTRY_DAILY_LIMIT: raw },
      });
      await seedSettings(t);

      for (let i = 0; i < DAILY_ENTRY_LIMIT; i += 1) {
        expect((await save(t, `https://example.com/${raw}-${i}`)).status).toBe(
          201,
        );
      }
      const res = await save(t, `https://example.com/${raw}-over`);
      expect(res.status).toBe(429);
      const body = (await res.json()) as LimitBody;
      expect(body.error.message).toBe("Daily entry limit reached (10/day).");
      await t.flush();
    },
  );

  it("still answers a duplicate with 409, even at the cap", async () => {
    // Error precedence: re-saving a link you already have must not be reported
    // as a quota problem, so the 409 check runs before the counter.
    const t = buildTestApp({
      now: () => PINNED_NOW,
      env: { ENTRY_DAILY_LIMIT: "2" },
    });
    await seedSettings(t);

    expect((await save(t, "https://example.com/dup")).status).toBe(201);
    expect((await save(t, "https://example.com/other")).status).toBe(201);

    const res = await save(t, "https://example.com/dup");
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("duplicate_url");
    expect(res.headers.get("retry-after")).toBeNull();
    await t.flush();
  });

  it("refuses an invalid URL with 400 before it looks at the cap", async () => {
    const t = buildTestApp({
      now: () => PINNED_NOW,
      env: { ENTRY_DAILY_LIMIT: "1" },
    });
    await seedSettings(t);
    expect((await save(t, "https://example.com/only")).status).toBe(201);

    const res = await save(t, "not-a-url");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_url");
    await t.flush();
  });
});
