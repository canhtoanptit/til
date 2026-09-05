import { describe, expect, it } from "vitest";
import { digestItems, digests, settings as settingsTable } from "@til/db";
import { asc, eq } from "drizzle-orm";
import type {
  Candidate,
  Embedder,
  SynthesisInput,
  SynthesisOptions,
} from "@til/core";
import {
  chunkForD1Insert,
  D1_MAX_BOUND_PARAMS,
  REPORT_ITEM_SOURCE_NAME,
  runDigest,
  startScheduledRun,
} from "./digest-run.js";
import {
  MONTHLY_REPORT_CRON,
  WEEKLY_CRON,
  type DigestRunParams,
} from "./digest.js";
import { parseEvidence } from "./dto.js";
import {
  buildTestApp,
  createRecordingWorkflow,
  inlineStep,
  insertEntry,
  makeCandidate,
  makeStubAdapter,
  makeStubEmbedder,
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

// Axis 0 = rust, 1 = sqlite; the two fixture clusters land on one axis each, so a
// saved entry about one of them scores 1 against it and 0 against the other.
const EMBED_DIMS = 8;
const TOPICS = [["rust"], ["sqlite"]];

function stubEmbedder(onEmbed?: (texts: string[]) => void): Embedder {
  return makeStubEmbedder(
    TOPICS,
    onEmbed === undefined
      ? { dimensions: EMBED_DIMS }
      : { dimensions: EMBED_DIMS, onEmbed },
  );
}

/** An entry the owner saved, plus the stored vector personalization reads. */
async function saveRead(deps: Deps, id: string, text: string): Promise<void> {
  await insertEntry(deps.db, {
    id,
    url: `https://example.com/${id}`,
    canonicalUrl: `https://example.com/${id}`,
    title: text,
    createdAt: NOW,
  });
  const store = deps.vectorStore;
  if (!store) throw new Error("test setup: no vector store");
  const [values] = await stubEmbedder().embed([text]);
  if (!values) throw new Error("test setup: stub returned no vector");
  await store.upsert([
    {
      id,
      userId: "owner",
      values,
      metadata: {
        domain: "example.com",
        createdAt: NOW,
        embedModel: "stub-embed",
      },
    },
  ]);
}

async function insertSettings(db: Deps["db"]): Promise<void> {
  await db.insert(settingsTable).values({
    id: 1,
    userId: "owner",
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

  it("stores no interest score when there is no embedder, and runs the same steps as before", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [
        makeStubAdapter("hn", [hnCandidate()]),
        makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
      ],
    });
    await insertSettings(t.deps.db);
    const step = inlineStep();

    const outcome = await runDigest(t.deps, params(), step.step);

    expect(outcome.status).toBe("ready");
    expect(step.names).toEqual([
      "plan",
      "fetch-hn",
      "fetch-lobsters",
      "rank",
      "synthesize",
      "persist",
    ]);
    const items = await t.deps.db
      .select()
      .from(digestItems)
      .orderBy(asc(digestItems.rank));
    // The loud story still wins, and nothing claims to have been measured.
    expect(items.map((i) => i.url)).toEqual([RUST_URL, SQLITE_URL]);
    expect(items.map((i) => i.interestScore)).toEqual([null, null]);
  });

  it("blends the owner's reading into the ranking and persists both halves", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder(),
      adapters: () => [
        makeStubAdapter("hn", [hnCandidate()]),
        makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
      ],
    });
    await insertSettings(t.deps.db);
    await saveRead(t.deps, "read-1", "sqlite WAL internals");
    const step = inlineStep();

    const outcome = await runDigest(t.deps, params(), step.step);

    expect(outcome.status).toBe("ready");
    // Between cluster+score and synthesize, as C18 specifies.
    expect(step.names).toEqual([
      "plan",
      "fetch-hn",
      "fetch-lobsters",
      "rank",
      "personalize",
      "synthesize",
      "persist",
    ]);

    const items = await t.deps.db
      .select()
      .from(digestItems)
      .orderBy(asc(digestItems.rank));
    // SQLite loses on base score (one source, fewer points) and wins on the blend.
    expect(items.map((i) => i.url)).toEqual([SQLITE_URL, RUST_URL]);
    expect(items[0]?.interestScore).toBeCloseTo(1, 12);
    expect(items[1]?.interestScore).toBeCloseTo(0, 12);
    // `score` stays the base topical score — the blend is not written over it.
    expect(items[0]?.score).toBeLessThan(items[1]?.score ?? 0);
  });

  it("gives the personalize step its own retry budget and timeout", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder(),
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    await insertSettings(t.deps.db);
    await saveRead(t.deps, "read-1", "rust ownership");
    const step = inlineStep();

    await runDigest(t.deps, params(), step.step);

    const index = step.names.indexOf("personalize");
    expect(index).toBeGreaterThanOrEqual(0);
    const config = step.configs[index];
    expect(config?.retries?.limit).toBeGreaterThanOrEqual(1);
    expect(config?.timeout).toBeDefined();
  });

  it("skips the embed call when nothing has been saved yet, and ranks as before", async () => {
    const embedded: string[][] = [];
    const t = buildTestApp({
      now: () => NOW,
      embedder: stubEmbedder((texts) => embedded.push(texts)),
      adapters: () => [
        makeStubAdapter("hn", [hnCandidate()]),
        makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
      ],
    });
    await insertSettings(t.deps.db);

    const outcome = await runDigest(t.deps, params(), inlineStep().step);

    expect(outcome.status).toBe("ready");
    expect(embedded).toEqual([]);
    const items = await t.deps.db
      .select()
      .from(digestItems)
      .orderBy(asc(digestItems.rank));
    expect(items.map((i) => i.url)).toEqual([RUST_URL, SQLITE_URL]);
    expect(items.map((i) => i.interestScore)).toEqual([null, null]);
  });

  it("degrades to base ranking when the embedder fails mid-run, without failing the digest", async () => {
    const throwing: Embedder = {
      model: "stub-embed",
      dimensions: EMBED_DIMS,
      embed: async () => {
        throw new Error("ollama unreachable");
      },
    };
    const t = buildTestApp({
      now: () => NOW,
      embedder: throwing,
      adapters: () => [
        makeStubAdapter("hn", [hnCandidate()]),
        makeStubAdapter("lobsters", [lobstersMirror(), lobstersOwn()]),
      ],
    });
    await insertSettings(t.deps.db);
    await saveRead(t.deps, "read-1", "sqlite WAL internals");
    const step = inlineStep();

    const outcome = await runDigest(t.deps, params(), step.step);

    expect(outcome).toEqual({
      digestId: DIGEST_ID,
      status: "ready",
      itemCount: 2,
    });
    expect(step.names).not.toContain("mark-failed");
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.status).toBe("ready");
    expect(run?.error).toBeNull();

    const items = await t.deps.db
      .select()
      .from(digestItems)
      .orderBy(asc(digestItems.rank));
    expect(items.map((i) => i.url)).toEqual([RUST_URL, SQLITE_URL]);
    expect(items.map((i) => i.interestScore)).toEqual([null, null]);
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

describe("runDigest — monthly report (P26)", () => {
  const REPORT_ID = "report-1";

  function reportParams(
    overrides: Partial<DigestRunParams> = {},
  ): DigestRunParams {
    return {
      digestId: REPORT_ID,
      windowDays: 30,
      maxItems: 10,
      kind: "monthly-report",
      now: PINNED,
      ...overrides,
    };
  }

  /** An entry the owner saved `daysAgo` before the run instant. */
  async function save(
    deps: Deps,
    id: string,
    daysAgo: number,
    overrides: {
      status?: "pending" | "ready" | "failed";
      title?: string;
      takeaway?: string;
      tags?: string[];
      domain?: string;
    } = {},
  ): Promise<void> {
    const domain = overrides.domain ?? "example.com";
    await insertEntry(deps.db, {
      id,
      url: `https://${domain}/${id}`,
      canonicalUrl: `https://${domain}/${id}`,
      title: overrides.title ?? `Saved ${id}`,
      takeaway: overrides.takeaway ?? `Takeaway ${id}`,
      tags: overrides.tags ?? ["alpha"],
      sourceDomain: domain,
      status: overrides.status ?? "ready",
      createdAt: PINNED - daysAgo * DAY,
    });
  }

  /** Adapters that would throw: a report must never touch an external source. */
  function forbiddenAdapters(): Deps["adapters"] {
    return () => [
      makeStubAdapter("hn", new Error("a report must not fetch candidates")),
    ];
  }

  it("persists a ready report over the owner's saves, with kind on the row", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await insertSettings(t.deps.db);
    await save(t.deps, "rust", 2, { title: "Rust incremental builds" });
    await save(t.deps, "sqlite", 9, { title: "SQLite WAL mode" });
    const step = inlineStep();

    const outcome = await runDigest(t.deps, reportParams(), step.step);

    expect(outcome).toEqual({
      digestId: REPORT_ID,
      status: "ready",
      itemCount: 2,
    });
    // No fetch-*, no rank, no personalize: those exist to find and order things
    // you have not read, and every input here is something you did read.
    expect(step.names).toEqual([
      "plan",
      "collect-entries",
      "synthesize",
      "persist",
    ]);

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, REPORT_ID))
    )[0];
    expect(run?.kind).toBe("monthly-report");
    expect(run?.status).toBe("ready");
    expect(run?.windowDays).toBe(30);
    expect(run?.runAt).toBe(PINNED);
    expect(run?.title).toBe("Stub Digest");
    expect(run?.error).toBeNull();
  });

  it("writes report items as saves: no score, no evidence, sourceName 'saved'", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await insertSettings(t.deps.db);
    await save(t.deps, "one", 1, { domain: "pgblog.example" });
    await save(t.deps, "two", 5, { domain: "rust-lang.org" });

    await runDigest(t.deps, reportParams(), inlineStep().step);

    const items = await t.deps.db
      .select()
      .from(digestItems)
      .where(eq(digestItems.digestId, REPORT_ID))
      .orderBy(asc(digestItems.rank));
    expect(items.map((i) => i.rank)).toEqual([1, 2]);
    // Most recently saved first, which is the only order the pool has.
    expect(items[0]?.url).toBe("https://pgblog.example/one");
    expect(items[0]?.sourceName).toBe(REPORT_ITEM_SOURCE_NAME);
    expect(items[0]?.sourceDomain).toBe("pgblog.example");
    expect(items[0]?.score).toBe(0);
    expect(items[0]?.interestScore).toBeNull();
    expect(parseEvidence(items[0]?.evidence)).toEqual([]);
    expect(items[0]?.why).toContain("https://pgblog.example/one");
  });

  it("hands the model the month's aggregates and the entries, and nothing else", async () => {
    const seenInputs: SynthesisInput[][] = [];
    const seenOpts: SynthesisOptions[] = [];
    const t = buildTestApp({
      now: () => NOW,
      adapters: forbiddenAdapters(),
      llmFactory: () =>
        makeStubLLM({
          synthesizeDigest: async (inputs, opts) => {
            seenInputs.push(inputs);
            seenOpts.push(opts);
            return { title: "Month", intro: "Intro.", items: [] };
          },
        }),
    });
    await insertSettings(t.deps.db);
    await save(t.deps, "a", 1, {
      domain: "rust-lang.org",
      tags: ["rust"],
      takeaway: "Incremental compilation landed.",
    });
    await save(t.deps, "b", 2, { domain: "rust-lang.org", tags: ["rust"] });
    await save(t.deps, "c", 3, { domain: "sqlite.org", tags: ["sqlite"] });
    await save(t.deps, "old", 45, { domain: "ancient.example", tags: ["old"] });

    await runDigest(t.deps, reportParams(), inlineStep().step);

    expect(seenOpts[0]?.kind).toBe("monthly-report");
    expect(seenOpts[0]?.windowDays).toBe(30);
    expect(seenOpts[0]?.report).toMatchObject({
      saved: 3,
      ready: 3,
      pending: 0,
      failed: 0,
      topDomains: [
        { domain: "rust-lang.org", count: 2 },
        { domain: "sqlite.org", count: 1 },
      ],
      reviewsGraded: 0,
    });
    // The out-of-window save is in neither the aggregates nor the pool.
    expect(seenInputs[0]?.map((i) => i.canonicalUrl)).toEqual([
      "https://rust-lang.org/a",
      "https://rust-lang.org/b",
      "https://sqlite.org/c",
    ]);
    expect(seenInputs[0]?.[0]?.snippet).toBe("Incremental compilation landed.");
    expect(seenInputs[0]?.[0]?.tags).toEqual(["rust"]);
    // Saved-at, not a publish date the app never learned.
    expect(seenInputs[0]?.[0]?.publishedAt).toBe(PINNED - DAY);
  });

  it("cannot highlight an entry the owner never saved", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: forbiddenAdapters(),
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
    await save(t.deps, "real", 1);

    const outcome = await runDigest(t.deps, reportParams(), inlineStep().step);

    expect(outcome.status).toBe("ready");
    expect(outcome.itemCount).toBe(0);
    expect(await t.deps.db.select().from(digestItems)).toHaveLength(0);
  });

  it("skips an empty month with a readable reason, without calling the LLM", async () => {
    let synthesisCalls = 0;
    const t = buildTestApp({
      now: () => NOW,
      adapters: forbiddenAdapters(),
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

    const outcome = await runDigest(t.deps, reportParams(), step.step);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("no entries were saved in this window");
    expect(synthesisCalls).toBe(0);
    expect(step.names).toContain("mark-failed");
    // Terminal, not left pending: a pending row would be swept into "digest run
    // timed out" 15 minutes later and lose the real reason.
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, REPORT_ID))
    )[0];
    expect(run?.status).toBe("failed");
    expect(run?.kind).toBe("monthly-report");
    expect(run?.error).toContain("nothing to report on");
  });

  it("skips when the month's saves all failed to process, and says so", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await insertSettings(t.deps.db);
    await save(t.deps, "broken", 3, { status: "failed" });
    await save(t.deps, "stuck", 4, { status: "pending" });

    const outcome = await runDigest(t.deps, reportParams(), inlineStep().step);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("2 entries were saved");
    expect(outcome.error).toContain("none finished processing");
  });

  it("fails with the same readable error as a weekly run when LLM settings are missing", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await save(t.deps, "one", 1);

    const outcome = await runDigest(t.deps, reportParams(), inlineStep().step);

    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("settings not configured");
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, REPORT_ID))
    )[0];
    expect(run?.status).toBe("failed");
  });

  it("re-running the same report id replaces its items instead of stacking them", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await insertSettings(t.deps.db);
    await save(t.deps, "one", 1);

    await runDigest(t.deps, reportParams(), inlineStep().step);
    await runDigest(t.deps, reportParams(), inlineStep().step);

    expect(await t.deps.db.select().from(digestItems)).toHaveLength(1);
    expect(await t.deps.db.select().from(digests)).toHaveLength(1);
  });

  it("leaves a weekly run's row and pipeline untouched", async () => {
    const t = buildTestApp({
      now: () => NOW,
      adapters: () => [makeStubAdapter("hn", [hnCandidate()])],
    });
    await insertSettings(t.deps.db);
    const step = inlineStep();

    await runDigest(t.deps, params(), step.step);

    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, DIGEST_ID))
    )[0];
    expect(run?.kind).toBe("weekly");
    expect(run?.windowDays).toBe(7);
    expect(step.names).toEqual([
      "plan",
      "fetch-hn",
      "rank",
      "synthesize",
      "persist",
    ]);
    const items = await t.deps.db.select().from(digestItems);
    expect(items[0]?.sourceName).toBe("hn");
    expect(items[0]?.score).toBeGreaterThan(0);
  });

  it("gives every report step a retry budget", async () => {
    const t = buildTestApp({ now: () => NOW, adapters: forbiddenAdapters() });
    await insertSettings(t.deps.db);
    await save(t.deps, "one", 1);
    const step = inlineStep();

    await runDigest(t.deps, reportParams(), step.step);

    for (const config of step.configs) {
      expect(config.retries?.limit).toBeGreaterThanOrEqual(1);
    }
    const collectIndex = step.names.indexOf("collect-entries");
    expect(step.configs[collectIndex]?.timeout).toBeDefined();
  });
});

describe("startScheduledRun — cron routing (P26)", () => {
  it("starts a weekly digest for the Monday cron", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({
      now: () => NOW,
      digestWorkflow: workflow.binding,
    });

    const started = await startScheduledRun(t.deps, WEEKLY_CRON);

    expect(started.kind).toBe("weekly");
    expect(started.windowDays).toBe(7);
    expect(workflow.created[0]?.params).toMatchObject({
      kind: "weekly",
      windowDays: 7,
    });
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, started.id))
    )[0];
    expect(run?.kind).toBe("weekly");
    expect(run?.status).toBe("pending");
  });

  it("starts a monthly report for the 1st-of-the-month cron", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({
      now: () => NOW,
      digestWorkflow: workflow.binding,
    });

    const started = await startScheduledRun(t.deps, MONTHLY_REPORT_CRON);

    expect(started.kind).toBe("monthly-report");
    expect(started.windowDays).toBe(30);
    expect(workflow.created[0]?.params).toMatchObject({
      kind: "monthly-report",
      windowDays: 30,
    });
    const run = (
      await t.deps.db.select().from(digests).where(eq(digests.id, started.id))
    )[0];
    expect(run?.kind).toBe("monthly-report");
    expect(run?.windowDays).toBe(30);
  });

  it("starts a weekly digest for an expression nobody claimed", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({
      now: () => NOW,
      digestWorkflow: workflow.binding,
    });
    const started = await startScheduledRun(t.deps, "0 0 * * *");
    expect(started.kind).toBe("weekly");
    expect(workflow.created).toHaveLength(1);
  });
});

describe("chunkForD1Insert", () => {
  // The production failure this pins: 10 digest items × 11 columns = 110 bound
  // parameters in one INSERT, over D1's cap of 100. better-sqlite3 (these
  // tests) allows ~32k binds, so only the chunk math can be asserted here —
  // which is exactly why it is math, not driver behaviour.
  const digestItemShapedRow = () => ({
    id: "x",
    digestId: "d",
    rank: 1,
    title: "t",
    url: "u",
    sourceName: "s",
    sourceDomain: "sd",
    score: 0.5,
    interestScore: null,
    why: null,
    evidence: "[]",
    createdAt: 0,
  });

  it("keeps every chunk within the D1 bound-parameter cap", () => {
    const rows = Array.from({ length: 30 }, digestItemShapedRow);
    const paramsPerRow = Object.keys(rows[0]!).length;
    const chunks = chunkForD1Insert(rows);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length * paramsPerRow).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMS,
      );
    }
  });

  it("covers all rows exactly once, in order", () => {
    const rows = Array.from({ length: 25 }, (_, i) => ({
      ...digestItemShapedRow(),
      rank: i + 1,
    }));
    const flattened = chunkForD1Insert(rows).flat();
    expect(flattened.map((r) => r.rank)).toEqual(rows.map((r) => r.rank));
  });

  it("handles the default 10-item run that failed in production", () => {
    const rows = Array.from({ length: 10 }, digestItemShapedRow);
    const paramsPerRow = Object.keys(rows[0]!).length;
    for (const chunk of chunkForD1Insert(rows)) {
      expect(chunk.length * paramsPerRow).toBeLessThanOrEqual(
        D1_MAX_BOUND_PARAMS,
      );
    }
  });

  it("returns no chunks for no rows", () => {
    expect(chunkForD1Insert([])).toEqual([]);
  });

  it("never produces an empty chunk even for very wide rows", () => {
    const wide = Object.fromEntries(
      Array.from({ length: 150 }, (_, i) => [`c${i}`, i]),
    );
    const chunks = chunkForD1Insert([wide, wide]);
    expect(chunks.map((c) => c.length)).toEqual([1, 1]);
  });
});
