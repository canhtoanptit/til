import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  digests as digestsTable,
  entries as entriesTable,
  feedback as feedbackTable,
  feeds as feedsTable,
  reviews as reviewsTable,
} from "@til/db";
import { DEFAULT_RSS_FEEDS } from "@til/core";
import type { Embedder, LLMSettings } from "@til/core";
import {
  buildTestApp,
  insertDigest,
  insertDigestItem,
  insertEntry,
  insertFeed,
  insertSettings,
  makeStubEmbedder,
  makeStubLLM,
} from "./test-harness.js";
import { indexConversation } from "./chat-index.js";
import { indexEntry } from "./indexing.js";
import { ingestEntry } from "./ingest.js";
import { relatedEntryRows, searchEntries, stats } from "./retrieval.js";
import { D1VectorStore } from "./vector-store.js";
import type { Deps } from "./deps.js";

/**
 * The cross-tenant isolation matrix (M5 phase 8).
 *
 * Every other suite in this directory asks "does this feature work?" with a
 * single signed-in user. This one asks the only question multi-user added:
 * **can one tenant observe another's rows through any surface the app exposes?**
 * So each case seeds at least two users and asserts on what the *second* one
 * sees — an empty list, a 404, a count — rather than on the feature's own
 * behaviour, which its own suite already covers.
 *
 * Cases deliberately NOT repeated here, because they already have a home:
 *   - chat route ownership (transcript/delete/proxy 404s, the `x-til-user-id`
 *     stamp on forwarded requests) — `chat.test.ts`, "chat routes — cross-tenant
 *     isolation". Only the `GET /api/chat` list exclusion is added below, which
 *     that describe does not cover.
 *   - per-user independence of the daily entry cap — `rate-limit.test.ts`,
 *     "counts per user — one tenant at the cap does not block another".
 *   - session/cookie identity itself (who a request is) — `auth.test.ts`,
 *     `auth-session.test.ts`.
 *   - digest cron fan-out eligibility per user — `digest-run.test.ts`.
 */

// The clock every worker suite pins. Fixtures that care about "stale" are
// written relative to it, never to the wall clock.
const NOW = 1_700_000_000_000;
const MINUTE_MS = 60 * 1000;
const DIMS = 4;

function jsonBody(
  method: string,
  body: unknown,
  user?: string,
): RequestInit & { user?: string } {
  return {
    method,
    ...(user === undefined ? {} : { user }),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** One axis per topic, so "same topic" entries land on the same unit vector. */
function topicEmbedder(): Embedder {
  return makeStubEmbedder(
    [
      ["kubernetes", "pods", "cluster"],
      ["css", "flexbox", "grid"],
    ],
    { dimensions: DIMS },
  );
}

/** An entry plus its vector, so the semantic leg has something to rank. */
async function seedIndexed(
  deps: Deps,
  opts: { id: string; userId: string; title: string; takeaway: string },
): Promise<void> {
  await insertEntry(deps.db, {
    id: opts.id,
    userId: opts.userId,
    url: `https://example.com/${opts.id}`,
    canonicalUrl: `https://example.com/${opts.id}`,
    title: opts.title,
    takeaway: opts.takeaway,
    createdAt: NOW,
  });
  await indexEntry(deps, {
    id: opts.id,
    userId: opts.userId,
    title: opts.title,
    summary: null,
    takeaway: opts.takeaway,
    tags: [],
    sourceDomain: "example.com",
    createdAt: NOW,
  });
}

describe("tenancy — entry object security", () => {
  it("404s every read and write on someone else's entry, and leaves the row alone", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "e-alice",
      userId: "alice",
      createdAt: NOW,
    });

    const probes = [
      await t.request("/api/entries/e-alice", { user: "bob" }),
      await t.request("/api/entries/e-alice/related", { user: "bob" }),
      await t.request(
        "/api/entries/e-alice",
        jsonBody("PATCH", { favorite: true }, "bob"),
      ),
      await t.request("/api/entries/e-alice", {
        method: "DELETE",
        user: "bob",
      }),
      await t.request("/api/entries/e-alice/reingest", {
        method: "POST",
        user: "bob",
      }),
    ];
    for (const res of probes) expect(res.status).toBe(404);
    // Same message as a genuine miss: a 404 must not double as an existence probe.
    const body = (await probes[0]!.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Entry not found.");

    const rows = await t.deps.db
      .select({ id: entriesTable.id, favorite: entriesTable.favorite })
      .from(entriesTable);
    expect(rows).toEqual([{ id: "e-alice", favorite: false }]);

    const mine = await t.request("/api/entries/e-alice", { user: "alice" });
    expect(mine.status).toBe(200);
  });
});

describe("tenancy — list, search, tags and stats", () => {
  it("shows each user only their own rows across all four read surfaces", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "e-alice",
      userId: "alice",
      url: "https://example.com/alice",
      canonicalUrl: "https://example.com/alice",
      // Distinctive enough that a leaking FTS leg could not hit it by accident.
      takeaway: "Zorbulax rewrites the scheduler.",
      tags: ["alicetag"],
      createdAt: NOW,
    });
    await insertEntry(t.deps.db, {
      id: "e-bob",
      userId: "bob",
      url: "https://example.com/bob",
      canonicalUrl: "https://example.com/bob",
      takeaway: "Quibbleton buffers the writes.",
      tags: ["bobtag"],
      createdAt: NOW,
    });

    const list = (await (
      await t.request("/api/entries", { user: "bob" })
    ).json()) as { items: { id: string }[] };
    expect(list.items.map((item) => item.id)).toEqual(["e-bob"]);

    // A term only alice's takeaway carries, so the keyword leg genuinely has a
    // foreign row to match on. Both layers guard it — the raw FTS predicate
    // (`e.user_id`) and the hydration filter — so this asserts the outcome, not
    // which of the two did the work.
    const foreign = (await (
      await t.request("/api/search?q=zorbulax", { user: "bob" })
    ).json()) as { items: { id: string }[] };
    expect(foreign.items).toEqual([]);
    const own = (await (
      await t.request("/api/search?q=zorbulax", { user: "alice" })
    ).json()) as { items: { id: string }[] };
    expect(own.items.map((item) => item.id)).toEqual(["e-alice"]);

    const tags = (await (
      await t.request("/api/tags", { user: "bob" })
    ).json()) as { items: { tag: string; count: number }[] };
    expect(tags.items).toEqual([{ tag: "bobtag", count: 1 }]);

    expect(await stats(t.deps, "bob", { kind: "totals" })).toEqual({
      kind: "totals",
      rows: [{ entries: 1, ready: 1, pending: 0, failed: 0 }],
    });
    expect(await stats(t.deps, "carol", { kind: "totals" })).toEqual({
      kind: "totals",
      rows: [{ entries: 0, ready: 0, pending: 0, failed: 0 }],
    });
  });
});

describe("tenancy — vector scoping", () => {
  /** Both users read about the same topic, so only the scope can separate them. */
  async function twoIndexedLibraries() {
    const t = buildTestApp({ now: () => NOW, embedder: topicEmbedder() });
    await seedIndexed(t.deps, {
      id: "k8s-alice-1",
      userId: "alice",
      title: "Pods and nodes",
      takeaway: "The cluster schedules pods onto nodes.",
    });
    await seedIndexed(t.deps, {
      id: "k8s-alice-2",
      userId: "alice",
      title: "Cluster autoscaling",
      takeaway: "The cluster adds nodes for pending pods.",
    });
    await seedIndexed(t.deps, {
      id: "k8s-bob-1",
      userId: "bob",
      title: "Pod eviction",
      takeaway: "The cluster evicts pods under memory pressure.",
    });
    await seedIndexed(t.deps, {
      id: "k8s-bob-2",
      userId: "bob",
      title: "Pod disruption budgets",
      takeaway: "A cluster drain respects pod budgets.",
    });
    return t;
  }

  it("keeps the semantic search leg inside the caller's library", async () => {
    const t = await twoIndexedLibraries();
    const found = await searchEntries(t.deps, "bob", {
      query: "kubernetes pods cluster",
    });
    expect(found.items.map((item) => item.id).sort()).toEqual([
      "k8s-bob-1",
      "k8s-bob-2",
    ]);
  });

  it("keeps related-entry neighbours inside the caller's library", async () => {
    const t = await twoIndexedLibraries();
    const related = await relatedEntryRows(t.deps, "bob", { id: "k8s-bob-1" });
    expect(related.available).toBe(true);
    expect(related.items.map(({ row }) => row.id)).toEqual(["k8s-bob-2"]);
  });

  it("scopes D1VectorStore.query through the parent entries join", async () => {
    const t = await twoIndexedLibraries();
    const store = new D1VectorStore(t.deps.db, DIMS, () => NOW);
    const [query] = await topicEmbedder().embed(["kubernetes pods cluster"]);
    const matches = await store.query(query!, { topK: 10, userId: "alice" });
    // `entry_vectors` holds all four rows; the join is the only thing filtering.
    expect(matches.map((match) => match.id).sort()).toEqual([
      "k8s-alice-1",
      "k8s-alice-2",
    ]);
  });
});

describe("tenancy — duplicate URLs across tenants", () => {
  it("lets two users save the same link, but not one user twice", async () => {
    const t = buildTestApp({ now: () => NOW });
    const url = "https://example.com/shared-article";

    const first = await t.request(
      "/api/entries",
      jsonBody("POST", { url }, "alice"),
    );
    expect(first.status).toBe(201);
    const aliceId = ((await first.json()) as { id: string }).id;

    const second = await t.request(
      "/api/entries",
      jsonBody("POST", { url }, "bob"),
    );
    expect(second.status).toBe(201);
    const bobId = ((await second.json()) as { id: string }).id;
    expect(bobId).not.toBe(aliceId);

    const again = await t.request(
      "/api/entries",
      jsonBody("POST", { url }, "alice"),
    );
    expect(again.status).toBe(409);
    const body = (await again.json()) as {
      error: { code: string };
      existingId: string;
    };
    expect(body.error.code).toBe("duplicate_url");
    // Alice's own row, never bob's — the dedupe lookup is scoped.
    expect(body.existingId).toBe(aliceId);
  });
});

describe("tenancy — feeds", () => {
  it("hides the owner's seeded feeds from everyone else", async () => {
    const t = buildTestApp({ now: () => NOW });
    const seeded = await t.deps.db
      .select({ id: feedsTable.id })
      .from(feedsTable)
      .where(eq(feedsTable.userId, "owner"));
    expect(seeded).toHaveLength(DEFAULT_RSS_FEEDS.length);

    const empty = (await (
      await t.request("/api/feeds", { user: "bob" })
    ).json()) as { items: unknown[] };
    expect(empty.items).toEqual([]);

    const created = await t.request(
      "/api/feeds",
      jsonBody("POST", { url: "https://jvns.ca/atom.xml" }, "bob"),
    );
    expect(created.status).toBe(201);

    const ownerFeedId = seeded[0]!.id;
    const toggled = await t.request(
      `/api/feeds/${ownerFeedId}`,
      jsonBody("PUT", { enabled: false }, "bob"),
    );
    expect(toggled.status).toBe(404);
    const removed = await t.request(`/api/feeds/${ownerFeedId}`, {
      method: "DELETE",
      user: "bob",
    });
    expect(removed.status).toBe(404);

    const survivors = await t.deps.db
      .select({ id: feedsTable.id, enabled: feedsTable.enabled })
      .from(feedsTable)
      .where(eq(feedsTable.id, ownerFeedId));
    expect(survivors).toEqual([{ id: ownerFeedId, enabled: true }]);
  });
});

describe("tenancy — digests", () => {
  it("excludes, 404s and does not sweep another user's runs", async () => {
    const t = buildTestApp({ now: () => NOW });
    const aliceDigest = await insertDigest(t.deps.db, {
      userId: "alice",
      runAt: NOW,
    });
    await insertDigestItem(t.deps.db, aliceDigest, { rank: 1 });
    // Old enough that an unscoped sweep (STALE_PENDING_MS = 15 min) would fail it.
    const alicePending = await insertDigest(t.deps.db, {
      userId: "alice",
      runAt: NOW - 60 * MINUTE_MS,
      status: "pending",
      updatedAt: NOW - 60 * MINUTE_MS,
    });

    const list = (await (
      await t.request("/api/digests", { user: "bob" })
    ).json()) as { items: { id: string }[] };
    expect(list.items).toEqual([]);

    expect(
      (await t.request(`/api/digests/${aliceDigest}`, { user: "bob" })).status,
    ).toBe(404);
    expect(
      (
        await t.request(`/api/digests/${aliceDigest}`, {
          method: "DELETE",
          user: "bob",
        })
      ).status,
    ).toBe(404);

    const rows = await t.deps.db
      .select({ id: digestsTable.id, status: digestsTable.status })
      .from(digestsTable);
    expect(rows).toEqual(
      expect.arrayContaining([
        { id: aliceDigest, status: "ready" },
        // Still pending: bob's list request swept only bob's rows.
        { id: alicePending, status: "pending" },
      ]),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("tenancy — reviews", () => {
  it("enrolls, queues and grades one library at a time", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "r-alice-1",
      userId: "alice",
      url: "https://example.com/a1",
      canonicalUrl: "https://example.com/a1",
      createdAt: NOW,
    });
    await insertEntry(t.deps.db, {
      id: "r-alice-2",
      userId: "alice",
      url: "https://example.com/a2",
      canonicalUrl: "https://example.com/a2",
      createdAt: NOW,
    });
    await insertEntry(t.deps.db, {
      id: "r-bob-1",
      userId: "bob",
      url: "https://example.com/b1",
      canonicalUrl: "https://example.com/b1",
      createdAt: NOW,
    });

    const enrolled = await t.request(
      "/api/reviews/enroll",
      jsonBody("POST", { all: true }, "alice"),
    );
    expect(await enrolled.json()).toEqual({ enrolled: 2, skipped: 0 });

    const cards = await t.deps.db
      .select({ entryId: reviewsTable.entryId, userId: reviewsTable.userId })
      .from(reviewsTable);
    expect(cards.map((card) => card.entryId).sort()).toEqual([
      "r-alice-1",
      "r-alice-2",
    ]);
    expect(cards.every((card) => card.userId === "alice")).toBe(true);

    const queue = (await (
      await t.request("/api/reviews/queue", { user: "bob" })
    ).json()) as {
      items: unknown[];
      dueCount: number;
      enrolledCount: number;
    };
    expect(queue).toEqual({ items: [], dueCount: 0, enrolledCount: 0 });

    const graded = await t.request(
      "/api/reviews/r-alice-1",
      jsonBody("POST", { grade: 3 }, "bob"),
    );
    expect(graded.status).toBe(404);
    const untouched = await t.deps.db
      .select({ lastGrade: reviewsTable.lastGrade })
      .from(reviewsTable)
      .where(eq(reviewsTable.entryId, "r-alice-1"));
    expect(untouched[0]?.lastGrade ?? null).toBeNull();
  });
});

describe("tenancy — feedback", () => {
  it("reads back only the caller's votes for a conversation id", async () => {
    const t = buildTestApp({ now: () => NOW });
    const posted = await t.request(
      "/api/feedback",
      jsonBody("POST", { conversationId: "c1", kind: "up" }, "alice"),
    );
    expect(posted.status).toBe(201);

    const foreign = (await (
      await t.request("/api/feedback?conversationId=c1", { user: "bob" })
    ).json()) as { items: unknown[] };
    expect(foreign.items).toEqual([]);

    const own = (await (
      await t.request("/api/feedback?conversationId=c1", { user: "alice" })
    ).json()) as { items: { kind: string }[] };
    expect(own.items.map((item) => item.kind)).toEqual(["up"]);
  });
});

describe("tenancy — export", () => {
  it("counts only the caller's rows, digest items included", async () => {
    const t = buildTestApp({ now: () => NOW });

    const aliceDigest = await insertDigest(t.deps.db, {
      userId: "alice",
      runAt: NOW,
    });
    await insertDigestItem(t.deps.db, aliceDigest, { rank: 1 });
    await insertDigestItem(t.deps.db, aliceDigest, { rank: 2 });
    await insertDigestItem(t.deps.db, aliceDigest, { rank: 3 });
    await insertEntry(t.deps.db, {
      id: "x-alice",
      userId: "alice",
      url: "https://example.com/xa",
      canonicalUrl: "https://example.com/xa",
      createdAt: NOW,
    });
    await insertFeed(t.deps.db, {
      userId: "alice",
      url: "https://a.example/f",
    });
    await t.deps.db.insert(reviewsTable).values({
      entryId: "x-alice",
      userId: "alice",
      state: "new",
      dueAt: NOW,
      intervalDays: 0,
      ease: 2.5,
      lapses: 0,
    });
    await t.deps.db.insert(feedbackTable).values({
      id: "fb-alice",
      userId: "alice",
      conversationId: "c1",
      messageId: null,
      entryId: null,
      kind: "up",
      comment: null,
      createdAt: NOW,
    });

    const bobDigest = await insertDigest(t.deps.db, {
      userId: "bob",
      runAt: NOW,
    });
    await insertDigestItem(t.deps.db, bobDigest, { rank: 1 });
    await insertEntry(t.deps.db, {
      id: "x-bob",
      userId: "bob",
      url: "https://example.com/xb",
      canonicalUrl: "https://example.com/xb",
      createdAt: NOW,
    });
    await insertFeed(t.deps.db, { userId: "bob", url: "https://b.example/f" });
    await t.deps.db.insert(reviewsTable).values({
      entryId: "x-bob",
      userId: "bob",
      state: "new",
      dueAt: NOW,
      intervalDays: 0,
      ease: 2.5,
      lapses: 0,
    });
    await t.deps.db.insert(feedbackTable).values({
      id: "fb-bob",
      userId: "bob",
      conversationId: "c9",
      messageId: null,
      entryId: null,
      kind: "down",
      comment: null,
      createdAt: NOW,
    });

    const res = await t.request("/api/export?format=json", { user: "bob" });
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text()) as {
      entries: { id: string }[];
      digestItems: { digestId: string }[];
      counts: Record<string, number>;
    };
    expect(body.counts).toEqual({
      entries: 1,
      digests: 1,
      // `digest_items` carries no user column: this number is the parent join.
      digestItems: 1,
      reviews: 1,
      feeds: 1,
      feedback: 1,
    });
    expect(body.entries.map((entry) => entry.id)).toEqual(["x-bob"]);
    expect(body.digestItems.map((item) => item.digestId)).toEqual([bobDigest]);
  });
});

describe("tenancy — chats list", () => {
  // The route-level gate (transcript, delete, agent proxy, header stamping) is
  // covered by chat.test.ts → "chat routes — cross-tenant isolation".
  it("lists only the caller's conversations", async () => {
    const t = buildTestApp({ now: () => NOW });
    await indexConversation(t.deps, "alice", "c1", {
      title: "About css",
      messageCount: 3,
    });
    await indexConversation(t.deps, "bob", "c2", {
      title: "About rust",
      messageCount: 1,
    });

    const listed = (await (
      await t.request("/api/chat", { user: "bob" })
    ).json()) as { items: { id: string }[] };
    expect(listed.items.map((item) => item.id)).toEqual(["c2"]);
  });
});

describe("tenancy — settings", () => {
  it("gives each user their own BYOK row, and 404s until they save one", async () => {
    const seen: LLMSettings[] = [];
    const t = buildTestApp({
      now: () => NOW,
      llmFactory: (settings) => {
        seen.push(settings);
        return makeStubLLM();
      },
    });

    expect((await t.request("/api/settings", { user: "bob" })).status).toBe(
      404,
    );
    expect(
      (await t.request("/api/settings/test", { method: "POST", user: "bob" }))
        .status,
    ).toBe(404);

    await insertSettings(t.deps.db, { userId: "alice", apiKey: "sk-alice" });
    const saved = await t.request(
      "/api/settings",
      jsonBody(
        "PUT",
        {
          provider: "openai",
          model: "gpt-4o-mini",
          apiKey: "sk-bob",
          cfAccountId: "acct-bob",
          cfGatewayId: "gw-bob",
        },
        "bob",
      ),
    );
    expect(saved.status).toBe(200);

    // Two rows, side by side under settings_user_uq — neither overwrote the other.
    const mine = (await (
      await t.request("/api/settings", { user: "bob" })
    ).json()) as { apiKeyMasked: string; cfAccountId: string };
    expect(mine.cfAccountId).toBe("acct-bob");
    const hers = (await (
      await t.request("/api/settings", { user: "alice" })
    ).json()) as { apiKeyMasked: string; cfAccountId: string };
    expect(hers.cfAccountId).toBe("acct");

    const tested = await t.request("/api/settings/test", {
      method: "POST",
      user: "bob",
    });
    expect(tested.status).toBe(200);
    expect(seen.map((settings) => settings.apiKey)).toEqual(["sk-bob"]);
  });

  it("ingests an entry with its own owner's settings, not the caller's", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertSettings(t.deps.db, { userId: "alice", apiKey: "sk-alice" });
    await insertEntry(t.deps.db, {
      id: "i-alice",
      userId: "alice",
      url: "https://example.com/ia",
      canonicalUrl: "https://example.com/ia",
      status: "pending",
      createdAt: NOW,
    });
    await insertEntry(t.deps.db, {
      id: "i-bob",
      userId: "bob",
      url: "https://example.com/ib",
      canonicalUrl: "https://example.com/ib",
      status: "pending",
      createdAt: NOW,
    });

    await ingestEntry(t.deps, "i-alice");
    await ingestEntry(t.deps, "i-bob");

    const rows = await t.deps.db
      .select({
        id: entriesTable.id,
        status: entriesTable.status,
        error: entriesTable.error,
      })
      .from(entriesTable);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get("i-alice")).toMatchObject({ status: "ready", error: null });
    // Bob has no BYOK row, so his ingest fails even though alice's would succeed.
    expect(byId.get("i-bob")).toMatchObject({
      status: "failed",
      error: "settings not configured",
    });
  });
});

describe("tenancy — stale entry sweep", () => {
  it("fails only the caller's timed-out pending entries", async () => {
    const t = buildTestApp({ now: () => NOW });
    // STALE_PENDING_MS is 10 minutes on the entries routes.
    await insertEntry(t.deps.db, {
      id: "s-alice",
      userId: "alice",
      url: "https://example.com/sa",
      canonicalUrl: "https://example.com/sa",
      status: "pending",
      createdAt: NOW - 11 * MINUTE_MS,
      updatedAt: NOW - 11 * MINUTE_MS,
    });

    await t.request("/api/entries", { user: "bob" });
    const afterForeignList = await t.deps.db
      .select({ status: entriesTable.status })
      .from(entriesTable)
      .where(
        and(eq(entriesTable.id, "s-alice"), eq(entriesTable.userId, "alice")),
      );
    expect(afterForeignList[0]?.status).toBe("pending");

    // The sweep is not broken, just scoped: alice's own list run does fail it.
    await t.request("/api/entries", { user: "alice" });
    const afterOwnList = await t.deps.db
      .select({ status: entriesTable.status })
      .from(entriesTable)
      .where(eq(entriesTable.id, "s-alice"));
    expect(afterOwnList[0]?.status).toBe("failed");
  });
});

describe("tenancy — owner default", () => {
  it("still serves the migration-seeded rows to the default user", async () => {
    const t = buildTestApp({ now: () => NOW });
    // The regression guard for the whole migration: every pre-0012 row was
    // backfilled to 'owner', and the default test session IS that user.
    const feedsListed = (await (await t.request("/api/feeds")).json()) as {
      items: { url: string }[];
    };
    expect(feedsListed.items.map((item) => item.url).sort()).toEqual(
      [...DEFAULT_RSS_FEEDS].sort(),
    );
  });
});
