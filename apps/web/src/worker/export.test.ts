import { describe, expect, it } from "vitest";
import {
  entryVectors,
  entries as entriesTable,
  feedback as feedbackTable,
  reviews as reviewsTable,
  settings as settingsTable,
} from "@til/db";
import { DEFAULT_RSS_FEEDS } from "@til/core";
import { eq, sql } from "drizzle-orm";
import type { Deps } from "./deps.js";
import {
  EXPORT_BATCH_SIZE,
  EXPORT_FAILURE_MARKER,
  EXPORT_FORMAT_VERSION,
  exportContentDisposition,
  exportFailureChunk,
  exportFilename,
  parseExportFormat,
  writeJsonExport,
} from "./export.js";
import {
  buildTestApp,
  insertDigest,
  insertDigestItem,
  insertEntry,
  insertFeed,
} from "./test-harness.js";

// 2023-11-14T22:13:20.000Z — the clock the rest of the worker suite pins, so the
// dated filename in every assertion below is derived, not guessed.
const NOW = 1_700_000_000_000;
const NOW_DATE = "2023-11-14";

// Distinctive on purpose: every "is the secret absent" assertion greps the raw
// response body for these, so a value that could occur by accident would make the
// test lie.
const SECRET_API_KEY = "sk-zzz-EXPORT-MUST-NEVER-CONTAIN-THIS-999";
const SECRET_AIG_TOKEN = "aig-zzz-ALSO-NEVER-EXPORTED-888";
const VECTOR_FINGERPRINT = "0.1234567890123";

interface ExportEnvelope {
  formatVersion: number;
  exportedAt: number;
  exportedAtIso: string;
  excluded: Record<string, string>;
  entries: {
    id: string;
    url: string;
    title: string | null;
    tags: string[];
    contentMarkdown: string | null;
    sourceDomain: string | null;
    takeaway: string | null;
    summary: string | null;
    createdAt: number;
  }[];
  digests: { id: string; title: string | null; intro: string | null }[];
  digestItems: {
    id: string;
    digestId: string;
    rank: number;
    title: string;
    url: string;
    evidence: { url: string; sourceName: string; title: string }[];
  }[];
  reviews: { entryId: string; state: string; ease: number }[];
  feeds: { id: string; url: string; enabled: boolean }[];
  feedback: { id: string; kind: string; comment: string | null }[];
  counts: Record<string, number>;
}

/** One row in every table the contract includes — plus rows in both tables it
 * deliberately excludes, so "absent" is a measured absence and not an empty db. */
async function seedEverything(db: Deps["db"]) {
  const entryId = await insertEntry(db, {
    id: "e-1",
    url: "https://example.com/streams",
    canonicalUrl: "https://example.com/streams",
    title: "Backpressure in web streams",
    summary: "A summary of how backpressure works.",
    takeaway: "Await the writer or you buffer the world.",
    question: "What does await writer.write() actually wait for?",
    sourceDomain: "example.com",
    tags: ["streams", "workers"],
    createdAt: NOW - 5_000,
  });
  await db
    .update(entriesTable)
    .set({
      contentMarkdown: "# Body\n\nThe whole article lives here.",
      note: "Compare this with the D1 param-cap incident.",
    })
    .where(eq(entriesTable.id, entryId));

  const digestId = await insertDigest(db, {
    id: "d-1",
    runAt: NOW - 4_000,
    title: "This week in streams",
    intro: "Three things worth your time.",
  });
  await insertDigestItem(db, digestId, {
    id: "di-1",
    rank: 1,
    title: "Streaming responses on Workers",
    url: "https://example.com/item-1",
    sourceDomain: "example.com",
    why: "Because it explains the memory ceiling.",
    evidence: [
      { url: "https://example.com/e", sourceName: "hn", title: "Evidence" },
    ],
    createdAt: NOW - 4_000,
  });

  // A review card needs the entry to exist (FK cascade), which it does.
  await db.insert(reviewsTable).values({
    entryId,
    state: "review",
    dueAt: NOW + 86_400_000,
    intervalDays: 3,
    ease: 2.5,
    lapses: 1,
    lastGrade: 3,
    reviewedAt: NOW - 1_000,
  });

  const feedId = await insertFeed(db, {
    id: "f-1",
    url: "https://mine.example.com/atom.xml",
    title: "Mine",
    createdAt: NOW - 3_000,
  });

  await db.insert(feedbackTable).values({
    id: "fb-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    entryId,
    kind: "up",
    comment: "That answer was right.",
    createdAt: NOW - 2_000,
  });

  // EXCLUDED tables — populated so their absence from the export is provable.
  await db.insert(settingsTable).values({
    id: 1,
    provider: "groq",
    model: "openai/gpt-oss-20b",
    apiKey: SECRET_API_KEY,
    cfAccountId: "acct-123",
    cfGatewayId: "gw-456",
    cfAigToken: SECRET_AIG_TOKEN,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(entryVectors).values({
    entryId,
    embedModel: "stub-embed",
    dims: 2,
    values: JSON.stringify([Number(VECTOR_FINGERPRINT), 0.5]),
    createdAt: NOW,
  });

  return { entryId, digestId, feedId };
}

async function getExport(
  request: ReturnType<typeof buildTestApp>["request"],
  query = "",
): Promise<{ res: Response; text: string }> {
  const res = await request(`/api/export${query}`);
  const text = await res.text();
  return { res, text };
}

async function getJsonExport(
  request: ReturnType<typeof buildTestApp>["request"],
): Promise<{ res: Response; text: string; body: ExportEnvelope }> {
  const { res, text } = await getExport(request);
  expect(res.status).toBe(200);
  return { res, text, body: JSON.parse(text) as ExportEnvelope };
}

describe("GET /api/export (json)", () => {
  it("carries one row from every included table, content and all", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { entryId, digestId, feedId } = await seedEverything(t.deps.db);
    const { body } = await getJsonExport(t.request);

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      id: entryId,
      url: "https://example.com/streams",
      title: "Backpressure in web streams",
      sourceDomain: "example.com",
      takeaway: "Await the writer or you buffer the world.",
      summary: "A summary of how backpressure works.",
      contentMarkdown: "# Body\n\nThe whole article lives here.",
    });
    // The JSON-in-TEXT column comes out as real JSON, not as a quoted string.
    expect(body.entries[0]?.tags).toEqual(["streams", "workers"]);

    expect(body.digests).toHaveLength(1);
    expect(body.digests[0]).toMatchObject({
      id: digestId,
      title: "This week in streams",
      intro: "Three things worth your time.",
    });

    expect(body.digestItems).toHaveLength(1);
    expect(body.digestItems[0]).toMatchObject({
      digestId,
      rank: 1,
      title: "Streaming responses on Workers",
      url: "https://example.com/item-1",
    });
    expect(body.digestItems[0]?.evidence).toEqual([
      { url: "https://example.com/e", sourceName: "hn", title: "Evidence" },
    ]);

    expect(body.reviews).toHaveLength(1);
    expect(body.reviews[0]).toMatchObject({
      entryId,
      state: "review",
      ease: 2.5,
    });

    // Migration 0005's three seeded feeds plus the one this test added.
    expect(body.feeds).toHaveLength(DEFAULT_RSS_FEEDS.length + 1);
    expect(body.feeds.map((f) => f.id)).toContain(feedId);
    expect(body.feeds.every((f) => typeof f.enabled === "boolean")).toBe(true);

    expect(body.feedback).toHaveLength(1);
    expect(body.feedback[0]).toMatchObject({
      id: "fb-1",
      kind: "up",
      comment: "That answer was right.",
    });
  });

  it("never carries the provider API key — the settings row is excluded", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { text, body } = await getJsonExport(t.request);

    // Asserted on the raw body, not the parsed object: a secret that leaked into
    // an unexpected key would still be in the file the owner downloads.
    expect(text).not.toContain(SECRET_API_KEY);
    expect(text).not.toContain(SECRET_AIG_TOKEN);
    expect(text).not.toContain("acct-123");
    expect(text).not.toContain("gw-456");
    expect(body).not.toHaveProperty("settings");

    // ...and the file says why, so the reason travels with the artefact.
    expect(body.excluded.settings).toMatch(/API key/i);
  });

  it("never carries embedding vectors — recomputable, so excluded", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { text, body } = await getJsonExport(t.request);

    expect(text).not.toContain(VECTOR_FINGERPRINT);
    expect(body).not.toHaveProperty("entryVectors");
    expect(body).not.toHaveProperty("entry_vectors");
    expect(body.excluded.entry_vectors).toMatch(/reembed/i);
  });

  it("has exactly the documented top-level keys and nothing else", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { body } = await getJsonExport(t.request);

    // An exact key set, not a spot check: this is what makes "no settings, no
    // vectors" a closed statement rather than a guess about which keys to look for.
    expect(Object.keys(body).sort()).toEqual([
      "counts",
      "digestItems",
      "digests",
      "entries",
      "excluded",
      "exportedAt",
      "exportedAtIso",
      "feedback",
      "feeds",
      "formatVersion",
      "reviews",
    ]);
  });

  it("stamps the envelope from the deps clock", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { body } = await getJsonExport(t.request);

    expect(body.formatVersion).toBe(EXPORT_FORMAT_VERSION);
    expect(body.exportedAt).toBe(NOW);
    expect(body.exportedAtIso).toBe("2023-11-14T22:13:20.000Z");
  });

  it("reports counts that match the arrays it wrote", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { body } = await getJsonExport(t.request);

    expect(body.counts).toEqual({
      entries: body.entries.length,
      digests: body.digests.length,
      digestItems: body.digestItems.length,
      reviews: body.reviews.length,
      feeds: body.feeds.length,
      feedback: body.feedback.length,
    });
    expect(body.counts).toMatchObject({
      entries: 1,
      digests: 1,
      digestItems: 1,
      reviews: 1,
      feeds: DEFAULT_RSS_FEEDS.length + 1,
      feedback: 1,
    });
  });

  it("is valid JSON with empty arrays on a fresh install", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { body } = await getJsonExport(t.request);

    expect(body.entries).toEqual([]);
    expect(body.digests).toEqual([]);
    expect(body.digestItems).toEqual([]);
    expect(body.reviews).toEqual([]);
    expect(body.feedback).toEqual([]);
    // Not empty: migration 0005 seeds three feeds into every install.
    expect(body.counts.feeds).toBe(DEFAULT_RSS_FEEDS.length);
  });

  it("attaches with a dated filename", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { res } = await getJsonExport(t.request);

    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="til-export-${NOW_DATE}.json"`,
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("requires the app token", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const res = await t.request("/api/export", { auth: false });
    expect(res.status).toBe(401);
    // The rejection must beat the first byte of the body.
    expect(await res.text()).not.toContain("Backpressure in web streams");
  });

  it("422s on an unknown format instead of streaming something arbitrary", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { res, text } = await getExport(t.request, "?format=zip");
    expect(res.status).toBe(422);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe(
      "validation_error",
    );
  });

  it("treats an absent, empty or explicit json format the same", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (const query of ["", "?format=", "?format=json"]) {
      const { res } = await getExport(t.request, query);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-disposition")).toContain(".json");
    }
  });
});

describe("GET /api/export?format=markdown", () => {
  async function getMarkdown(t: ReturnType<typeof buildTestApp>) {
    const { res, text } = await getExport(t.request, "?format=markdown");
    expect(res.status).toBe(200);
    return { res, text };
  }

  it("renders a titled header, then one section per entry in contract order", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { text } = await getMarkdown(t);

    expect(text.startsWith("# TIL export\n")).toBe(true);
    expect(text).toContain(`Exported ${NOW_DATE} (2023-11-14T22:13:20.000Z).`);
    expect(text).toContain("## Entries");

    // title, url, domain, saved date, tags, takeaway, summary, then content —
    // asserted by position, because "present somewhere" would not be the contract.
    const order = [
      "### Backpressure in web streams",
      "- URL: https://example.com/streams",
      "- Domain: example.com",
      `- Saved: ${NOW_DATE}`,
      "- Tags: streams, workers",
      "**Takeaway.** Await the writer or you buffer the world.",
      "**My note.** Compare this with the D1 param-cap incident.",
      "A summary of how backpressure works.",
      "#### Content",
      "The whole article lives here.",
    ];
    let cursor = -1;
    for (const fragment of order) {
      const at = text.indexOf(fragment, cursor + 1);
      expect(at, `"${fragment}" out of order or missing`).toBeGreaterThan(
        cursor,
      );
      cursor = at;
    }
  });

  it("closes with the digests, their intro and linked items", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { text } = await getMarkdown(t);

    const digestsAt = text.indexOf("## Digests");
    expect(digestsAt).toBeGreaterThan(text.indexOf("## Entries"));
    const tail = text.slice(digestsAt);
    expect(tail).toContain("### This week in streams");
    expect(tail).toContain("Three things worth your time.");
    expect(tail).toContain(
      "1. [Streaming responses on Workers](https://example.com/item-1) · example.com — Because it explains the memory ceiling.",
    );
    expect(
      text.trimEnd().endsWith("1 entries · 1 digests · 1 digest items."),
    ).toBe(true);
  });

  it("says out loud that it is not the restore format", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { text } = await getMarkdown(t);
    expect(text).toContain("not a restore file");
    expect(text).toMatch(/API key/i);
  });

  it("never carries the provider API key or the vectors either", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    const { text } = await getMarkdown(t);
    expect(text).not.toContain(SECRET_API_KEY);
    expect(text).not.toContain(SECRET_AIG_TOKEN);
    expect(text).not.toContain(VECTOR_FINGERPRINT);
  });

  it("attaches as a dated .md and serves markdown", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { res } = await getMarkdown(t);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(res.headers.get("content-disposition")).toBe(
      `attachment; filename="til-export-${NOW_DATE}.md"`,
    );
  });

  it("stays readable with an empty library", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { text } = await getMarkdown(t);
    expect(text).toContain("_No entries saved yet._");
    expect(text).toContain("_No digests yet._");
    expect(
      text.trimEnd().endsWith("0 entries · 0 digests · 0 digest items."),
    ).toBe(true);
  });

  it("requires the app token", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/export?format=markdown", { auth: false });
    expect(res.status).toBe(401);
  });

  it("accepts the md alias", async () => {
    const t = buildTestApp({ now: () => NOW });
    const { res } = await getExport(t.request, "?format=md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain(".md");
  });
});

describe("keyset batching", () => {
  // A page-sized boundary is where an off-by-one cursor shows up: one row short
  // and the walk stops early, one row over and the boundary row is emitted twice.
  const OVER_ONE_PAGE = EXPORT_BATCH_SIZE + 3;

  it("walks past the batch boundary without dropping or repeating a row", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < OVER_ONE_PAGE; i++) {
      await insertEntry(t.deps.db, {
        id: `e-${String(i).padStart(4, "0")}`,
        url: `https://example.com/a-${i}`,
        canonicalUrl: `https://example.com/a-${i}`,
        // Every row shares a createdAt on purpose: the keyset then depends
        // entirely on the id tiebreaker to make progress.
        createdAt: NOW,
      });
    }
    const { body } = await getJsonExport(t.request);

    expect(body.counts.entries).toBe(OVER_ONE_PAGE);
    const ids = body.entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(OVER_ONE_PAGE);
    expect([...ids].sort()).toEqual(ids);
  });

  it("walks a digest's items past the boundary, in rank order", async () => {
    const t = buildTestApp({ now: () => NOW });
    const digestId = await insertDigest(t.deps.db, { id: "d-big", runAt: NOW });
    for (let i = 1; i <= OVER_ONE_PAGE; i++) {
      await insertDigestItem(t.deps.db, digestId, {
        id: `di-${String(i).padStart(4, "0")}`,
        rank: i,
      });
    }
    const { body } = await getJsonExport(t.request);

    expect(body.counts.digestItems).toBe(OVER_ONE_PAGE);
    expect(body.digestItems.map((i) => i.rank)).toEqual(
      Array.from({ length: OVER_ONE_PAGE }, (_, i) => i + 1),
    );

    // The markdown path walks the same rows through a scoped cursor.
    const { text } = await getExport(t.request, "?format=markdown");
    expect(text).toContain(`${OVER_ONE_PAGE} digest items.`);
  });
});

describe("writeJsonExport streams instead of buffering", () => {
  // Chunk boundaries are not observable through `app.fetch` + `res.text()` — the
  // response body is reassembled before a test ever sees it. So the streaming
  // property is asserted one level down, against the sink the route hands over:
  // a writer that buffered would call `write` a fixed number of times, and one
  // that streams scales its writes with the number of rows.
  it("writes at least once per row, and never holds the document in one chunk", async () => {
    const t = buildTestApp({ now: () => NOW });
    const rows = 40;
    for (let i = 0; i < rows; i++) {
      await insertEntry(t.deps.db, {
        id: `e-${String(i).padStart(3, "0")}`,
        url: `https://example.com/s-${i}`,
        canonicalUrl: `https://example.com/s-${i}`,
        createdAt: NOW + i,
      });
    }

    const chunks: string[] = [];
    const counts = await writeJsonExport(t.deps.db, NOW, {
      write: async (chunk) => {
        chunks.push(chunk);
        return undefined;
      },
    });

    expect(counts.entries).toBe(rows);
    expect(chunks.length).toBeGreaterThan(rows);
    // No single chunk is the whole file.
    const whole = chunks.join("");
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThan(whole.length);
    }
    expect(() => JSON.parse(whole) as unknown).not.toThrow();
  });
});

describe("a failure mid-stream", () => {
  it("breaks the file loudly instead of handing over a plausible truncation", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedEverything(t.deps.db);
    // The `feedback` array is the last thing written before `counts`, so dropping
    // its table fails the walk with the envelope and every entry already on the
    // wire — exactly the case where the status line cannot be taken back.
    await t.deps.db.run(sql`DROP TABLE feedback`);

    const { res, text } = await getExport(t.request);
    // Still 200: the headers left before anything could go wrong. That is the
    // whole reason the failure has to be reported in the body.
    expect(res.status).toBe(200);
    expect(text).toContain("Backpressure in web streams");
    expect(text).toContain(EXPORT_FAILURE_MARKER);
    // No `counts`, and not parseable — a truncated backup must not be mistakable
    // for a complete one with fewer rows in it.
    expect(text).not.toContain('"counts"');
    expect(() => JSON.parse(text) as unknown).toThrow();
  });

  it("names the failure in the marker, even for a thrown non-Error", () => {
    expect(exportFailureChunk(new Error("D1 went away"))).toContain(
      "D1 went away",
    );
    // `stream`'s own onError hook ignores non-Errors, which is why the route
    // catches instead of delegating — this path has to keep working.
    expect(exportFailureChunk("just a string")).toContain("just a string");
    expect(exportFailureChunk("x")).toContain(EXPORT_FAILURE_MARKER);
  });
});

describe("export format helpers", () => {
  it("maps the accepted format spellings and rejects the rest", () => {
    expect(parseExportFormat(null)).toBe("json");
    expect(parseExportFormat("")).toBe("json");
    expect(parseExportFormat("json")).toBe("json");
    expect(parseExportFormat("markdown")).toBe("markdown");
    expect(parseExportFormat("md")).toBe("markdown");
    for (const bad of ["JSON", "zip", "csv", "MD", "yaml"]) {
      expect(parseExportFormat(bad)).toBeNull();
    }
  });

  it("dates the filename in UTC, so it matches exportedAt", () => {
    // 23:30 UTC on the 14th is already the 15th in +02:00 — the filename must
    // follow the stamp inside the file, not the reader's clock.
    const lateUtc = Date.parse("2023-11-14T23:30:00.000Z");
    expect(exportFilename("json", lateUtc)).toBe("til-export-2023-11-14.json");
    expect(exportFilename("markdown", lateUtc)).toBe(
      "til-export-2023-11-14.md",
    );
    expect(exportContentDisposition("json", lateUtc)).toBe(
      'attachment; filename="til-export-2023-11-14.json"',
    );
  });
});
