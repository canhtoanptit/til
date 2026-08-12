import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { feeds, settings as settingsTable } from "@til/db";
import { DEFAULT_RSS_FEEDS } from "@til/core";
import type { Candidate, SourceAdapter } from "@til/core";
import { createDefaultAdapters, type AdapterFactoryOptions } from "./digest.js";
import { runDigest } from "./digest-run.js";
import { listEnabledFeedUrls } from "./feeds.js";
import type { Deps } from "./deps.js";
import {
  buildTestApp,
  inlineStep,
  insertFeed,
  makeCandidate,
  makeStubAdapter,
} from "./test-harness.js";

// Deliberately AFTER the instant migration 0005 stamps on its seeded rows, so a
// feed added during a test sorts after the seeds the way it will in production.
// (The rest of the worker suite pins 1_700_000_000_000, which predates the seed.)
const NOW = 1_790_000_000_000;

interface FeedBody {
  id: string;
  url: string;
  title: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ErrorBody {
  error: { code: string; message: string };
  existingId?: string;
}

async function listFeeds(
  request: ReturnType<typeof buildTestApp>["request"],
): Promise<FeedBody[]> {
  const res = await request("/api/feeds");
  expect(res.status).toBe(200);
  const body = (await res.json()) as { items: FeedBody[] };
  return body.items;
}

function addFeed(
  request: ReturnType<typeof buildTestApp>["request"],
  url: unknown,
) {
  return request("/api/feeds", {
    method: "POST",
    body: JSON.stringify({ url }),
    headers: { "content-type": "application/json" },
  });
}

function setEnabled(
  request: ReturnType<typeof buildTestApp>["request"],
  id: string,
  enabled: unknown,
) {
  return request(`/api/feeds/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/feeds", () => {
  it("returns the three seeded defaults, enabled, in insertion order", async () => {
    const t = buildTestApp({ now: () => NOW });
    const items = await listFeeds(t.request);

    expect(items.map((f) => f.url)).toEqual([...DEFAULT_RSS_FEEDS]);
    expect(items.every((f) => f.enabled)).toBe(true);
    // The seed carries a human label; the API never invents one for added feeds.
    expect(items.every((f) => (f.title ?? "").length > 0)).toBe(true);
  });

  it("requires the app token", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/feeds", { auth: false });
    expect(res.status).toBe(401);
  });
});

describe("POST /api/feeds", () => {
  it("creates a feed and returns it, enabled by default", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await addFeed(t.request, "https://example.com/atom.xml");
    expect(res.status).toBe(201);
    const body = (await res.json()) as FeedBody;
    expect(body).toMatchObject({
      url: "https://example.com/atom.xml",
      title: null,
      enabled: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(body.id.length).toBeGreaterThan(0);

    const items = await listFeeds(t.request);
    expect(items.map((f) => f.url)).toContain("https://example.com/atom.xml");
    expect(items).toHaveLength(DEFAULT_RSS_FEEDS.length + 1);
  });

  it("trims and stores the parsed url so case-only variants collide", async () => {
    const t = buildTestApp({ now: () => NOW });
    const created = await addFeed(
      t.request,
      "  HTTPS://Example.COM/Atom.xml  ",
    );
    expect(created.status).toBe(201);
    // Host lowercased, path left alone — the path is the origin's business.
    expect(((await created.json()) as FeedBody).url).toBe(
      "https://example.com/Atom.xml",
    );

    const again = await addFeed(t.request, "https://example.com/Atom.xml");
    expect(again.status).toBe(409);
  });

  it("409s on a duplicate url and names the existing row", async () => {
    const t = buildTestApp({ now: () => NOW });
    const first = (await (
      await addFeed(t.request, "https://example.com/atom.xml")
    ).json()) as FeedBody;

    const res = await addFeed(t.request, "https://example.com/atom.xml");
    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("duplicate_url");
    expect(body.existingId).toBe(first.id);

    expect(await listFeeds(t.request)).toHaveLength(
      DEFAULT_RSS_FEEDS.length + 1,
    );
  });

  it("409s on a seeded default without creating a second row", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await addFeed(t.request, "https://jvns.ca/atom.xml");
    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).existingId).toBe("feed-jvns-ca");
  });

  it.each([
    ["http://localhost/feed.xml", "unsafe_url"],
    ["http://127.0.0.1:8080/feed.xml", "unsafe_url"],
    ["http://10.0.0.5/feed.xml", "unsafe_url"],
    ["http://[::1]/feed.xml", "unsafe_url"],
    ["file:///etc/passwd", "unsafe_url"],
    ["ftp://example.com/feed.xml", "unsafe_url"],
    ["not a url at all", "invalid_url"],
    ["/relative/feed.xml", "invalid_url"],
  ])("rejects %s with %s", async (url, code) => {
    const t = buildTestApp({ now: () => NOW });
    const res = await addFeed(t.request, url);
    expect(res.status).toBe(400);
    expect(((await res.json()) as ErrorBody).error.code).toBe(code);
    expect(await listFeeds(t.request)).toHaveLength(DEFAULT_RSS_FEEDS.length);
  });

  it("422s when url is missing or not a string", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (const url of [undefined, "", 42]) {
      const res = await addFeed(t.request, url);
      expect(res.status).toBe(422);
      expect(((await res.json()) as ErrorBody).error.code).toBe(
        "validation_error",
      );
    }
  });
});

describe("PUT /api/feeds/:id", () => {
  it("disables and re-enables a feed, stamping updatedAt", async () => {
    let clock = NOW;
    const t = buildTestApp({ now: () => clock });

    clock = NOW + 1_000;
    const off = await setEnabled(t.request, "feed-jvns-ca", false);
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({
      id: "feed-jvns-ca",
      url: "https://jvns.ca/atom.xml",
      enabled: false,
      updatedAt: NOW + 1_000,
    });

    const disabled = (await listFeeds(t.request)).find(
      (f) => f.id === "feed-jvns-ca",
    );
    expect(disabled?.enabled).toBe(false);

    clock = NOW + 2_000;
    const on = await setEnabled(t.request, "feed-jvns-ca", true);
    expect(on.status).toBe(200);
    expect(await on.json()).toMatchObject({
      enabled: true,
      updatedAt: NOW + 2_000,
    });
  });

  it("404s for an unknown id", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await setEnabled(t.request, "nope", false);
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });

  it("422s when enabled is not a boolean", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await setEnabled(t.request, "feed-jvns-ca", "yes");
    expect(res.status).toBe(422);
    expect(((await res.json()) as ErrorBody).error.code).toBe(
      "validation_error",
    );
    // The row must be untouched by a rejected payload.
    const row = (await listFeeds(t.request)).find(
      (f) => f.id === "feed-jvns-ca",
    );
    expect(row?.enabled).toBe(true);
  });
});

describe("DELETE /api/feeds/:id", () => {
  it("deletes the feed and 204s", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/feeds/feed-jvns-ca", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect((await listFeeds(t.request)).map((f) => f.id)).toEqual([
      "feed-blog-cloudflare-com",
      "feed-simonwillison-net",
    ]);
  });

  it("404s for an unknown id", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await t.request("/api/feeds/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as ErrorBody).error.code).toBe("not_found");
  });

  it("deleting a feed does not touch the other rows or other tables", async () => {
    const t = buildTestApp({ now: () => NOW });
    await addFeed(t.request, "https://example.com/atom.xml");
    await t.request("/api/feeds/feed-jvns-ca", { method: "DELETE" });
    expect(await listEnabledFeedUrls(t.deps.db)).toEqual([
      "https://blog.cloudflare.com/rss/",
      "https://simonwillison.net/atom/everything/",
      "https://example.com/atom.xml",
    ]);
  });
});

describe("listEnabledFeedUrls", () => {
  it("skips disabled rows and keeps insertion order", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertFeed(t.deps.db, {
      id: "f-late",
      url: "https://late.example.com/atom.xml",
      createdAt: NOW + 10,
    });
    await insertFeed(t.deps.db, {
      id: "f-off",
      url: "https://off.example.com/atom.xml",
      enabled: false,
      createdAt: NOW + 20,
    });
    await t.deps.db
      .update(feeds)
      .set({ enabled: false })
      .where(eq(feeds.id, "feed-blog-cloudflare-com"));

    expect(await listEnabledFeedUrls(t.deps.db)).toEqual([
      "https://jvns.ca/atom.xml",
      "https://simonwillison.net/atom/everything/",
      "https://late.example.com/atom.xml",
    ]);
  });

  it("returns an empty list when every feed is disabled", async () => {
    const t = buildTestApp({ now: () => NOW });
    await t.deps.db.update(feeds).set({ enabled: false });
    expect(await listEnabledFeedUrls(t.deps.db)).toEqual([]);
  });
});

describe("createDefaultAdapters", () => {
  it("builds the rss adapter from the supplied feeds", async () => {
    const captured: string[] = [];
    const adapters = createDefaultAdapters({
      now: NOW,
      feeds: ["https://a.example.com/atom.xml", "https://b.example.com/rss/"],
    });
    expect(adapters.map((a) => a.name)).toEqual([
      "hn",
      "lobsters",
      "arxiv",
      "rss",
    ]);

    const rss = adapters.find((a) => a.name === "rss") as SourceAdapter;
    await rss.fetchCandidates({
      windowDays: 7,
      limit: 10,
      fetchImpl: (async (input: RequestInfo | URL) => {
        captured.push(typeof input === "string" ? input : String(input));
        return new Response(EMPTY_ATOM, {
          headers: { "content-type": "application/atom+xml" },
        });
      }) as unknown as typeof fetch,
    });
    expect(captured).toEqual([
      "https://a.example.com/atom.xml",
      "https://b.example.com/rss/",
    ]);
  });

  it("omits the rss adapter entirely when no feed is enabled", () => {
    const adapters = createDefaultAdapters({ now: NOW, feeds: [] });
    expect(adapters.map((a) => a.name)).toEqual(["hn", "lobsters", "arxiv"]);
  });
});

const EMPTY_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`;

describe("runDigest reads its feeds from D1", () => {
  const DIGEST_ID = "feeds-run";

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

  function candidate(): Candidate {
    return makeCandidate({
      url: "https://example.com/thing",
      title: "A thing worth reading about databases",
      sourceName: "hn",
      publishedAt: NOW - 86_400_000,
      popularity: 50,
    });
  }

  function harness() {
    const seen: AdapterFactoryOptions[] = [];
    const t = buildTestApp({
      now: () => NOW,
      adapters: (opts) => {
        seen.push(opts);
        return [makeStubAdapter("hn", [candidate()])];
      },
    });
    return { t, seen };
  }

  it("hands the adapter factory the enabled feed urls, not the hardcoded defaults", async () => {
    const { t, seen } = harness();
    await insertSettings(t.deps.db);
    await insertFeed(t.deps.db, {
      id: "f-mine",
      url: "https://mine.example.com/atom.xml",
      createdAt: NOW + 1,
    });

    const outcome = await runDigest(
      t.deps,
      { digestId: DIGEST_ID, windowDays: 7, maxItems: 10, now: NOW },
      inlineStep().step,
    );

    expect(outcome.status).toBe("ready");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.feeds).toEqual([
      ...DEFAULT_RSS_FEEDS,
      "https://mine.example.com/atom.xml",
    ]);
  });

  it("drops a feed the owner disabled through the API", async () => {
    const { t, seen } = harness();
    await insertSettings(t.deps.db);
    const res = await setEnabled(t.request, "feed-jvns-ca", false);
    expect(res.status).toBe(200);

    await runDigest(
      t.deps,
      { digestId: DIGEST_ID, windowDays: 7, maxItems: 10, now: NOW },
      inlineStep().step,
    );

    expect(seen[0]?.feeds).toEqual([
      "https://blog.cloudflare.com/rss/",
      "https://simonwillison.net/atom/everything/",
    ]);
  });

  it("still completes with every feed disabled — the other sources carry the run", async () => {
    const { t, seen } = harness();
    await insertSettings(t.deps.db);
    await t.deps.db.update(feeds).set({ enabled: false });

    const outcome = await runDigest(
      t.deps,
      { digestId: DIGEST_ID, windowDays: 7, maxItems: 10, now: NOW },
      inlineStep().step,
    );

    expect(seen[0]?.feeds).toEqual([]);
    expect(outcome).toMatchObject({ status: "ready", itemCount: 1 });
  });

  it("freezes the feed list in the plan step, so a mid-run toggle cannot split a run", async () => {
    const seen: AdapterFactoryOptions[] = [];
    const t = buildTestApp({
      now: () => NOW,
      adapters: (opts) => {
        seen.push(opts);
        return [makeStubAdapter("hn", [candidate()])];
      },
    });
    await insertSettings(t.deps.db);

    const step = inlineStep();
    const wrapped = {
      do: async <T,>(
        name: string,
        config: Parameters<typeof step.step.do>[1],
        fn: () => Promise<T>,
      ): Promise<T> => {
        const out = await step.step.do(name, config, fn);
        // The owner turns everything off the instant planning finishes.
        if (name === "plan") await t.deps.db.update(feeds).set({ enabled: false });
        return out;
      },
    };

    await runDigest(
      t.deps,
      { digestId: DIGEST_ID, windowDays: 7, maxItems: 10, now: NOW },
      wrapped,
    );

    expect(seen[0]?.feeds).toEqual([...DEFAULT_RSS_FEEDS]);
    expect(await listEnabledFeedUrls(t.deps.db)).toEqual([]);
  });
});
