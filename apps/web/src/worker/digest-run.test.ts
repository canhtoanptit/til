import { describe, expect, it } from "vitest";
import { digestItems, digests, settings as settingsTable } from "@til/db";
import { asc, eq } from "drizzle-orm";
import type { Candidate, SynthesisInput } from "@til/core";
import { runDigest } from "./digest-run.js";
import type { DigestRunParams } from "./digest.js";
import { parseEvidence } from "./dto.js";
import {
  buildTestApp,
  inlineStep,
  makeCandidate,
  makeStubAdapter,
  makeStubLLM,
} from "./test-harness.js";
import type { Deps } from "./deps.js";

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
// Deliberately different from `now()` so a leak of the wall clock is visible.
const PINNED = NOW - 5 * DAY;
const DIGEST_ID = "run-1";

const RUST_URL = "https://blog.rust-lang.org/incremental";
const SQLITE_URL = "https://example.com/sqlite-wal";

function params(overrides: Partial<DigestRunParams> = {}): DigestRunParams {
  return {
    digestId: DIGEST_ID,
    windowDays: 7,
    maxItems: 10,
    now: PINNED,
    ...overrides,
  };
}

function hnCandidate(): Candidate {
  return makeCandidate({
    url: RUST_URL,
    title: "Rust compiler gets faster incremental builds",
    sourceName: "hn",
    publishedAt: PINNED - DAY,
    popularity: 120,
    snippet: "Incremental compilation landed.",
  });
}

function lobstersMirror(): Candidate {
  return makeCandidate({
    url: RUST_URL,
    title: "Rust compiler gets faster incremental builds",
    sourceName: "lobsters",
    publishedAt: PINNED - DAY,
    popularity: 45,
  });
}

function lobstersOwn(): Candidate {
  return makeCandidate({
    url: SQLITE_URL,
    title: "SQLite WAL mode explained in depth",
    sourceName: "lobsters",
    publishedAt: PINNED - DAY,
    popularity: 30,
  });
}

async function insertSettings(db: Deps["db"]): Promise<void> {
  await db.insert(settingsTable).values({
    id: 1,
    provider: "groq",
    model: "llama-3.3-70b",
    apiKey: "test-key",
    cfAccountId: "acct",
    cfGatewayId: "gw",
    cfAigToken: null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("runDigest", () => {
  it("persists a ready run with ranked items, evidence and one row per synthesis item", async () => {
    const seenNow: number[] = [];
    const t = buildTestApp({
      now: () => NOW,
      adapters: (opts) => {
        seenNow.push(opts.now);
        return [
          makeStubAdapter("hn", [hnCandidate()]),
          makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
        ];
      },
    });
    await insertSettings(t.deps.db);
    const step = inlineStep();

    const outcome = await runDigest(t.deps, params(), step.step);

    expect(outcome).toEqual({
      digestId: DIGEST_ID,
      status: "ready",
      itemCount: 2,
    });
    expect(step.names).toEqual([
      "plan",
      "fetch-hn",
      "fetch-lobsters",
      "rank",
      "synthesize",
      "persist",
    ]);

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.status).toBe("ready");
    expect(run?.title).toBe("Stub Digest");
    expect(run?.intro).toBe("Stub digest intro.");
    expect(run?.error).toBeNull();
    // WHY: proves the captured instant, not the wall clock, drove the run.
    expect(run?.runAt).toBe(PINNED);
    expect(seenNow).toEqual([PINNED]);

    const items = await t.deps.db
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, DIGEST_ID))
      .orderBy(asc(digestItems.rank));
    expect(items.map((i) => i.rank)).toEqual([1, 2]);
    expect(items[0]?.url).toBe(RUST_URL);
    expect(items[0]?.sourceName).toBe("hn");
    expect(items[0]?.sourceDomain).toBe("blog.rust-lang.org");
    expect(items[0]?.score).toBeGreaterThan(items[1]?.score ?? 1);
    expect(items[0]?.why).toContain(RUST_URL);
    expect(parseEvidence(items[0]?.evidence)).toEqual([
      {
        url: RUST_URL,
        sourceName: "hn",
        title: "Rust compiler gets faster incremental builds",
      },
      {
        url: RUST_URL,
        sourceName: "lobsters",
        title: "Rust compiler gets faster incremental builds",
      },
    ]);
    expect(items[1]?.url).toBe(SQLITE_URL);
    expect(parseEvidence(items[1]?.evidence)).toHaveLength(1);
  });

  it("creates the pending row when the trigger did not (bare workflow instance)", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    await insertSettings(t.deps.db);

    await runDigest(
      t.deps,
      params({ digestId: "fresh-id" }),
      inlineStep().step,
    );

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, "fresh-id"))
    )[0];
    expect(run?.status).toBe("ready");
    expect(run?.runAt).toBe(PINNED);
    expect(run?.windowDays).toBe(7);
  });

  it("keeps going when one source fails and others succeed", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [
        makeStubAdapter("hn", new Error("hn: HTTP 503")),
        makeStubAdapter("lobsters", [lobstersOwn()]),
      ],
    });
    await insertSettings(t.deps.db);

    const outcome = await runDigest(t.deps, params(), inlineStep().step);

    expect(outcome.status).toBe("ready");
    expect(outcome.itemCount).toBe(1);
    const items = await t.deps.db.select().from(digestItems);
    expect(items[0]?.url).toBe(SQLITE_URL);
  });

  it("fails the run only when every source fails, and never calls the LLM", async () => {
    let synthesisCalls = 0;
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [
        makeStubAdapter("hn", new Error("hn: HTTP 503")),
        makeStubAdapter("lobsters", new Error("lobsters: timeout")),
      ],
      llmFactory: () =>
        makeStubLLM({
          synthesizeDigest: async () => {
            synthesisCalls += 1;
            throw new Error("should not be called");
          },
        }),
    });
    await insertSettings(t.deps.db);
    const step = inlineStep();

    const outcome = await runDigest(t.deps, params(), step.step);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("all 2 source(s) failed");
    expect(outcome.error).toContain("hn: HTTP 503");
    expect(outcome.error).toContain("lobsters: timeout");
    expect(synthesisCalls).toBe(0);
    expect(step.names).toContain("mark-failed");

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("all 2 source(s) failed");
    expect(await t.deps.db.select().from(digestItems)).toHaveLength(0);
  });

  it("fails when no source returned a candidate, without calling the LLM", async () => {
    let synthesisCalls = 0;
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [])],
      llmFactory: () =>
        makeStubLLM({
          synthesizeDigest: async () => {
            synthesisCalls += 1;
            throw new Error("should not be called");
          },
        }),
    });
    await insertSettings(t.deps.db);

    const outcome = await runDigest(t.deps, params(), inlineStep().step);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no candidates found in the last 7 day(s)");
    expect(synthesisCalls).toBe(0);
  });

  it("fails with a readable error when no sources are configured", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: () => [] });
    await insertSettings(t.deps.db);
    const outcome = await runDigest(t.deps, params(), inlineStep().step);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no digest sources are configured");
  });

  it("fails with a readable error when LLM settings are missing", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    const outcome = await runDigest(t.deps, params(), inlineStep().step);
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("settings not configured");
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.status).toBe("failed");
  });

  it("persists exactly what synthesis kept when the model drops items", async () => {
    const seen: SynthesisInput[][] = [];
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [
        makeStubAdapter("hn", [hnCandidate()]),
        makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
      ],
      llmFactory: () =>
        makeStubLLM({
          synthesizeDigest: async (inputs) => {
            seen.push(inputs);
            const kept = inputs[1];
            return {
              title: "Only one thing",
              intro: "Just the one.",
              items: kept
                ? [
                    {
                      canonicalUrl: kept.canonicalUrl,
                      title: "Rewritten title",
                      why: "The only pick.",
                    },
                  ]
                : [],
            };
          },
        }),
    });
    await insertSettings(t.deps.db);

    const outcome = await runDigest(
      t.deps,
      params({ maxItems: 4 }),
      inlineStep().step,
    );

    expect(seen[0]).toHaveLength(2);
    expect(outcome.itemCount).toBe(1);
    const items = await t.deps.db.select().from(digestItems);
    expect(items).toHaveLength(1);
    expect(items[0]?.rank).toBe(1);
    expect(items[0]?.title).toBe("Rewritten title");
    expect(items[0]?.url).toBe(SQLITE_URL);
  });

  it("ignores synthesis items that reference an unknown url", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
      llmFactory: () =>
        makeStubLLM({
          synthesizeDigest: async () => ({
            title: "T",
            intro: "I",
            items: [
              {
                canonicalUrl: "https://hallucinated.example/nope",
                title: "Nope",
                why: "Invented.",
              },
            ],
          }),
        }),
    });
    await insertSettings(t.deps.db);

    const outcome = await runDigest(t.deps, params(), inlineStep().step);

    expect(outcome.status).toBe("ready");
    expect(outcome.itemCount).toBe(0);
    expect(await t.deps.db.select().from(digestItems)).toHaveLength(0);
  });

  it("re-running the same digest id replaces items instead of stacking them", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    await insertSettings(t.deps.db);

    await runDigest(t.deps, params(), inlineStep().step);
    await runDigest(t.deps, params(), inlineStep().step);

    const items = await t.deps.db.select().from(digestItems);
    expect(items).toHaveLength(1);
    expect(await t.deps.db.select().from(digests)).toHaveLength(1);
  });

  it("clamps out-of-range params and gives every source step a retry budget", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    await insertSettings(t.deps.db);
    const step = inlineStep();

    await runDigest(
      t.deps,
      params({ windowDays: 9999, maxItems: 0 }),
      step.step,
    );

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.windowDays).toBe(30);

    const fetchIndex = step.names.indexOf("fetch-hn");
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    const fetchConfig = step.configs[fetchIndex];
    expect(fetchConfig?.retries?.limit).toBeGreaterThanOrEqual(1);
    expect(fetchConfig?.timeout).toBeDefined();
    for (const config of step.configs) {
      expect(config.retries?.limit).toBeGreaterThanOrEqual(1);
    }
  });
});
