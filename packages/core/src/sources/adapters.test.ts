import { describe, expect, it } from "vitest";
import { SourceError } from "../errors.js";
import type { Candidate, FetchCandidatesOptions } from "../types.js";
import { createArxivAdapter } from "./arxiv.js";
import { createHNAdapter } from "./hn.js";
import { JSON_ACCEPT, SOURCE_USER_AGENT, XML_ACCEPT } from "./http.js";
import { createLobstersAdapter } from "./lobsters.js";
import { DEFAULT_RSS_FEEDS, defaultAdapters } from "./registry.js";
import { createRssAdapter, feedSourceName } from "./rss.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function makeFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = v;
    }
    const req: CapturedRequest = {
      url: typeof input === "string" ? input : input.toString(),
      headers,
    };
    captured.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function xmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/atom+xml" },
  });
}

async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject, but it resolved");
}

const DAY_MS = 86_400_000;
const NOW = Date.parse("2024-01-20T12:00:00Z");
const WINDOW_DAYS = 3;
// Window start is 2024-01-17T12:00:00Z; fixtures straddle it deliberately.
const WINDOW_START = NOW - WINDOW_DAYS * DAY_MS;

const now = (): number => NOW;

function options(
  fetchImpl: typeof fetch,
  over: Partial<FetchCandidatesOptions> = {},
): FetchCandidatesOptions {
  return { windowDays: WINDOW_DAYS, limit: 10, fetchImpl, ...over };
}

describe("HNAdapter", () => {
  const freshSeconds = Date.parse("2024-01-19T09:00:00Z") / 1000;
  const textPostSeconds = Date.parse("2024-01-19T11:00:00Z") / 1000;
  const staleSeconds = Date.parse("2024-01-10T09:00:00Z") / 1000;

  const hits: unknown[] = [
    {
      objectID: "39000001",
      title: "  A deep dive into  Postgres indexes  ",
      url: "https://blog.example.com/postgres-indexes",
      points: 412,
      created_at_i: freshSeconds,
    },
    {
      objectID: "39000002",
      title: "Ask HN: What are you working on?",
      url: null,
      points: 88,
      created_at_i: textPostSeconds,
      story_text: "<p>Share your side projects here.</p>",
    },
    {
      objectID: "39000003",
      title: "Two weeks stale",
      url: "https://blog.example.com/stale",
      points: 900,
      created_at_i: staleSeconds,
    },
    {
      objectID: "39000004",
      title: "Loopback link",
      url: "http://127.0.0.1/x",
      points: 500,
      created_at_i: freshSeconds,
    },
    {
      objectID: "39000005",
      title: "Script link",
      url: "javascript:alert(1)",
      points: 500,
      created_at_i: freshSeconds,
    },
    {
      objectID: "39000006",
      url: "https://blog.example.com/untitled",
      points: 500,
      created_at_i: freshSeconds,
    },
    {
      objectID: "39000007",
      title: "Missing timestamp",
      url: "https://blog.example.com/no-ts",
      points: 500,
    },
  ];

  it("builds the search_by_date query from windowDays, limit and minPoints", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ hits: [] }));
    const adapter = createHNAdapter({ now });
    await adapter.fetchCandidates(options(fetchImpl, { limit: 25 }));

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://hn.algolia.com/api/v1/search_by_date",
    );
    expect(url.searchParams.get("tags")).toBe("story");
    expect(url.searchParams.get("hitsPerPage")).toBe("25");
    expect(url.searchParams.get("numericFilters")).toBe(
      `created_at_i>${Math.floor(WINDOW_START / 1000)},points>50`,
    );
  });

  it("honours a custom minPoints and clamps limit to at least 1", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ hits: [] }));
    const adapter = createHNAdapter({ now, minPoints: 250 });
    await adapter.fetchCandidates(options(fetchImpl, { limit: 0 }));

    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("numericFilters")).toBe(
      `created_at_i>${Math.floor(WINDOW_START / 1000)},points>250`,
    );
    expect(url.searchParams.get("hitsPerPage")).toBe("1");
  });

  it("sends the digest user-agent and a JSON accept header", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({ hits: [] }));
    await createHNAdapter({ now }).fetchCandidates(options(fetchImpl));

    expect(captured[0]!.headers["user-agent"]).toBe(SOURCE_USER_AGENT);
    expect(captured[0]!.headers["accept"]).toBe(JSON_ACCEPT);
  });

  it("maps hits to candidates, falling back to the item page for text posts", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ hits }));
    const candidates = await createHNAdapter({ now }).fetchCandidates(
      options(fetchImpl),
    );

    expect(candidates).toEqual([
      {
        url: "https://blog.example.com/postgres-indexes",
        title: "A deep dive into Postgres indexes",
        sourceName: "hn",
        publishedAt: freshSeconds * 1000,
        popularity: 412,
      },
      {
        url: "https://news.ycombinator.com/item?id=39000002",
        title: "Ask HN: What are you working on?",
        sourceName: "hn",
        publishedAt: textPostSeconds * 1000,
        popularity: 88,
        snippet: "Share your side projects here.",
      },
    ] satisfies Candidate[]);
  });

  it("stops at the requested limit", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ hits }));
    const candidates = await createHNAdapter({ now }).fetchCandidates(
      options(fetchImpl, { limit: 1 }),
    );
    expect(candidates.map((c) => c.url)).toEqual([
      "https://blog.example.com/postgres-indexes",
    ]);
  });

  it("keeps an item published exactly at the window boundary", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        hits: [
          {
            objectID: "1",
            title: "Right on the boundary",
            url: "https://blog.example.com/boundary",
            created_at_i: WINDOW_START / 1000,
          },
        ],
      }),
    );
    const candidates = await createHNAdapter({ now }).fetchCandidates(
      options(fetchImpl),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.publishedAt).toBe(WINDOW_START);
  });

  it("throws SourceError tagged with the source on HTTP 500", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() =>
      createHNAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "hn" });
    expect(String(err)).toContain("500");
  });

  it("throws SourceError on an unparseable body", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await rejection(() =>
      createHNAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "hn" });
  });

  it("throws SourceError when the payload has no hits array", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ nbHits: 0 }));
    const err = await rejection(() =>
      createHNAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "hn" });
  });
});

describe("LobstersAdapter", () => {
  const stories: unknown[] = [
    {
      short_id: "abc123",
      title: "Writing a  toy scheduler in Zig",
      url: "https://zig.example.com/toy-scheduler",
      score: 42,
      created_at: "2024-01-19T08:15:00.000-06:00",
      comments_url: "https://lobste.rs/s/abc123/writing_a_toy_scheduler_in_zig",
      description_plain: "A small cooperative scheduler.",
      description: "<p>A small cooperative scheduler.</p>",
    },
    {
      short_id: "def456",
      title: "Ask: how do you review code?",
      url: "",
      score: 7,
      created_at: "2024-01-19T10:00:00.000Z",
      comments_url: "https://lobste.rs/s/def456/ask_how_do_you_review_code",
    },
    {
      short_id: "ghi789",
      title: "Short id fallback story",
      url: "",
      created_at: "2024-01-18T00:00:00.000Z",
    },
    {
      short_id: "jkl012",
      title: "Stale story",
      url: "https://zig.example.com/stale",
      score: 300,
      created_at: "2024-01-05T00:00:00.000Z",
    },
    {
      short_id: "mno345",
      title: "Private network story",
      url: "http://10.0.0.5/internal",
      score: 300,
      created_at: "2024-01-19T00:00:00.000Z",
    },
    {
      short_id: "pqr678",
      title: "Unparseable date",
      url: "https://zig.example.com/bad-date",
      created_at: "whenever",
    },
  ];

  it("requests the hottest feed by default", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse([]));
    await createLobstersAdapter({ now }).fetchCandidates(options(fetchImpl));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("https://lobste.rs/hottest.json");
    expect(captured[0]!.headers["user-agent"]).toBe(SOURCE_USER_AGENT);
    expect(captured[0]!.headers["accept"]).toBe(JSON_ACCEPT);
  });

  it("requests the newest feed when configured", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse([]));
    await createLobstersAdapter({ now, feed: "newest" }).fetchCandidates(
      options(fetchImpl),
    );
    expect(captured[0]!.url).toBe("https://lobste.rs/newest.json");
  });

  it("maps stories, falling back to comments_url then short_id for text posts", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse(stories));
    const candidates = await createLobstersAdapter({ now }).fetchCandidates(
      options(fetchImpl),
    );

    expect(candidates).toEqual([
      {
        url: "https://zig.example.com/toy-scheduler",
        title: "Writing a toy scheduler in Zig",
        sourceName: "lobsters",
        publishedAt: Date.parse("2024-01-19T14:15:00Z"),
        popularity: 42,
        snippet: "A small cooperative scheduler.",
      },
      {
        url: "https://lobste.rs/s/def456/ask_how_do_you_review_code",
        title: "Ask: how do you review code?",
        sourceName: "lobsters",
        publishedAt: Date.parse("2024-01-19T10:00:00Z"),
        popularity: 7,
      },
      {
        url: "https://lobste.rs/s/ghi789",
        title: "Short id fallback story",
        sourceName: "lobsters",
        publishedAt: Date.parse("2024-01-18T00:00:00Z"),
      },
    ] satisfies Candidate[]);
  });

  it("applies the limit client-side because the feed is not paginated", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse(stories));
    const candidates = await createLobstersAdapter({ now }).fetchCandidates(
      options(fetchImpl, { limit: 2 }),
    );
    expect(captured[0]!.url).toBe("https://lobste.rs/hottest.json");
    expect(candidates).toHaveLength(2);
  });

  it("throws SourceError tagged with the source on HTTP 500", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() =>
      createLobstersAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "lobsters" });
  });

  it("throws SourceError when the payload is not an array", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({ stories: [] }));
    const err = await rejection(() =>
      createLobstersAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "lobsters" });
  });
});

const ARXIV_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query</title>
  <entry>
    <id>http://arxiv.org/abs/2401.00001v1</id>
    <updated>2024-01-19T12:00:00Z</updated>
    <published>2024-01-19T10:00:00Z</published>
    <title>Scaling  Laws
      for Sparse Models</title>
    <summary>We study &lt;b&gt;scaling&lt;/b&gt; laws.</summary>
    <link href="http://arxiv.org/abs/2401.00001v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2401.00001v1" rel="related" type="application/pdf"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00002v2</id>
    <updated>2024-01-18T08:00:00Z</updated>
    <title>Sparse Attention Revisited</title>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2312.99999v1</id>
    <published>2023-12-30T08:00:00Z</published>
    <title>Well Outside The Window</title>
    <link href="http://arxiv.org/abs/2312.99999v1" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00003v1</id>
    <published>2024-01-19T08:00:00Z</published>
    <title>Served From A Private Host</title>
    <link href="http://127.0.0.1/paper" rel="alternate" type="text/html"/>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/2401.00004v1</id>
    <title>No Timestamp At All</title>
  </entry>
</feed>`;

describe("ArxivAdapter", () => {
  it("builds the query URL with the default category filter", async () => {
    const { fetchImpl, captured } = makeFetch(() => xmlResponse(ARXIV_FEED));
    await createArxivAdapter({ now }).fetchCandidates(
      options(fetchImpl, { limit: 15 }),
    );

    expect(captured).toHaveLength(1);
    const url = new URL(captured[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://export.arxiv.org/api/query",
    );
    expect(url.searchParams.get("search_query")).toBe("cat:cs.AI OR cat:cs.LG");
    expect(url.searchParams.get("sortBy")).toBe("submittedDate");
    expect(url.searchParams.get("sortOrder")).toBe("descending");
    expect(url.searchParams.get("max_results")).toBe("15");
    expect(captured[0]!.headers["user-agent"]).toBe(SOURCE_USER_AGENT);
    expect(captured[0]!.headers["accept"]).toBe(XML_ACCEPT);
  });

  it("honours a custom query and clamps max_results to at least 1", async () => {
    const { fetchImpl, captured } = makeFetch(() => xmlResponse(ARXIV_FEED));
    await createArxivAdapter({ now, query: "cat:cs.DB" }).fetchCandidates(
      options(fetchImpl, { limit: 0 }),
    );
    const url = new URL(captured[0]!.url);
    expect(url.searchParams.get("search_query")).toBe("cat:cs.DB");
    expect(url.searchParams.get("max_results")).toBe("1");
  });

  it("parses an Atom feed into candidates", async () => {
    const { fetchImpl } = makeFetch(() => xmlResponse(ARXIV_FEED));
    const candidates = await createArxivAdapter({ now }).fetchCandidates(
      options(fetchImpl),
    );

    expect(candidates).toEqual([
      {
        url: "http://arxiv.org/abs/2401.00001v1",
        title: "Scaling Laws for Sparse Models",
        sourceName: "arxiv",
        publishedAt: Date.parse("2024-01-19T10:00:00Z"),
        snippet: "We study scaling laws.",
      },
      {
        url: "http://arxiv.org/abs/2401.00002v2",
        title: "Sparse Attention Revisited",
        sourceName: "arxiv",
        publishedAt: Date.parse("2024-01-18T08:00:00Z"),
      },
    ] satisfies Candidate[]);
  });

  it("makes exactly one request and respects the limit", async () => {
    const { fetchImpl, captured } = makeFetch(() => xmlResponse(ARXIV_FEED));
    const candidates = await createArxivAdapter({ now }).fetchCandidates(
      options(fetchImpl, { limit: 1 }),
    );
    expect(captured).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });

  it("throws SourceError tagged with the source on HTTP 500", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() =>
      createArxivAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "arxiv" });
  });

  it("throws SourceError when the payload is not an Atom feed", async () => {
    const { fetchImpl } = makeFetch(() =>
      xmlResponse("<html><body>not a feed</body></html>"),
    );
    const err = await rejection(() =>
      createArxivAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "arxiv" });
  });

  it("throws SourceError on an empty payload", async () => {
    const { fetchImpl } = makeFetch(() => xmlResponse("   "));
    const err = await rejection(() =>
      createArxivAdapter({ now }).fetchCandidates(options(fetchImpl)),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "arxiv" });
  });
});

const RSS_FEED_URL = "https://blog.example.com/rss.xml";
const ATOM_FEED_URL = "https://notes.example.org/atom.xml";

const RSS_2_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Example Blog</title>
    <link>https://blog.example.com/</link>
    <item>
      <title>How DNS works</title>
      <link>https://blog.example.com/dns</link>
      <pubDate>Fri, 19 Jan 2024 09:30:00 GMT</pubDate>
      <description>&lt;p&gt;A tour of DNS resolution.&lt;/p&gt;</description>
    </item>
    <item>
      <title>Only a permalink guid</title>
      <guid isPermaLink="true">https://blog.example.com/guid-post</guid>
      <pubDate>Thu, 18 Jan 2024 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Too old for the window</title>
      <link>https://blog.example.com/old</link>
      <pubDate>Fri, 05 Jan 2024 09:30:00 GMT</pubDate>
    </item>
    <item>
      <title>Points at a private host</title>
      <link>http://192.168.1.10/admin</link>
      <pubDate>Fri, 19 Jan 2024 08:00:00 GMT</pubDate>
    </item>
    <item>
      <title>No date at all</title>
      <link>https://blog.example.com/undated</link>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Example Notes</title>
  <entry>
    <title>Notes on B-trees</title>
    <link rel="alternate" type="text/html" href="https://notes.example.org/btrees"/>
    <link rel="self" href="https://notes.example.org/btrees.atom"/>
    <updated>2024-01-19T11:00:00Z</updated>
    <content type="html">&lt;p&gt;Why fanout matters.&lt;/p&gt;</content>
  </entry>
  <entry>
    <title>Older note</title>
    <link rel="alternate" type="text/html" href="https://notes.example.org/older"/>
    <published>2024-01-18T11:00:00Z</published>
  </entry>
  <entry>
    <title>Ancient note</title>
    <link rel="alternate" type="text/html" href="https://notes.example.org/ancient"/>
    <published>2023-11-01T11:00:00Z</published>
  </entry>
</feed>`;

describe("RssAdapter", () => {
  function feedRouter(req: CapturedRequest): Response {
    if (req.url === RSS_FEED_URL) return xmlResponse(RSS_2_FEED);
    if (req.url === ATOM_FEED_URL) return xmlResponse(ATOM_FEED);
    return new Response("not found", { status: 404 });
  }

  it("derives sourceName from the feed host", () => {
    expect(feedSourceName(RSS_FEED_URL)).toBe("rss:blog.example.com");
    expect(feedSourceName(ATOM_FEED_URL)).toBe("rss:notes.example.org");
  });

  it("parses RSS 2.0 items, including the guid permalink fallback", async () => {
    const { fetchImpl, captured } = makeFetch(feedRouter);
    const candidates = await createRssAdapter({
      now,
      feeds: [RSS_FEED_URL],
    }).fetchCandidates(options(fetchImpl));

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe(RSS_FEED_URL);
    expect(captured[0]!.headers["user-agent"]).toBe(SOURCE_USER_AGENT);
    expect(captured[0]!.headers["accept"]).toBe(XML_ACCEPT);
    expect(candidates).toEqual([
      {
        url: "https://blog.example.com/dns",
        title: "How DNS works",
        sourceName: "rss:blog.example.com",
        publishedAt: Date.parse("2024-01-19T09:30:00Z"),
        snippet: "A tour of DNS resolution.",
      },
      {
        url: "https://blog.example.com/guid-post",
        title: "Only a permalink guid",
        sourceName: "rss:blog.example.com",
        publishedAt: Date.parse("2024-01-18T09:30:00Z"),
      },
    ] satisfies Candidate[]);
  });

  it("parses Atom entries via link[@href] and updated", async () => {
    const { fetchImpl } = makeFetch(feedRouter);
    const candidates = await createRssAdapter({
      now,
      feeds: [ATOM_FEED_URL],
    }).fetchCandidates(options(fetchImpl));

    expect(candidates).toEqual([
      {
        url: "https://notes.example.org/btrees",
        title: "Notes on B-trees",
        sourceName: "rss:notes.example.org",
        publishedAt: Date.parse("2024-01-19T11:00:00Z"),
        snippet: "Why fanout matters.",
      },
      {
        url: "https://notes.example.org/older",
        title: "Older note",
        sourceName: "rss:notes.example.org",
        publishedAt: Date.parse("2024-01-18T11:00:00Z"),
      },
    ] satisfies Candidate[]);
  });

  it("merges feeds newest-first and applies the limit across all of them", async () => {
    const { fetchImpl, captured } = makeFetch(feedRouter);
    const adapter = createRssAdapter({
      now,
      feeds: [RSS_FEED_URL, ATOM_FEED_URL],
    });

    const all = await adapter.fetchCandidates(options(fetchImpl));
    expect(captured.map((r) => r.url)).toEqual([RSS_FEED_URL, ATOM_FEED_URL]);
    expect(all.map((c) => c.url)).toEqual([
      "https://notes.example.org/btrees",
      "https://blog.example.com/dns",
      "https://notes.example.org/older",
      "https://blog.example.com/guid-post",
    ]);

    const capped = await adapter.fetchCandidates(
      options(fetchImpl, { limit: 2 }),
    );
    expect(capped.map((c) => c.url)).toEqual([
      "https://notes.example.org/btrees",
      "https://blog.example.com/dns",
    ]);
  });

  it("isolates a failing feed and still returns the healthy one", async () => {
    const { fetchImpl } = makeFetch((req) =>
      req.url === RSS_FEED_URL
        ? new Response("boom", { status: 500 })
        : feedRouter(req),
    );
    const failures: { feedUrl: string; error: unknown }[] = [];
    const candidates = await createRssAdapter({
      now,
      feeds: [RSS_FEED_URL, ATOM_FEED_URL],
      onFeedError: (feedUrl, error) => failures.push({ feedUrl, error }),
    }).fetchCandidates(options(fetchImpl));

    expect(candidates.map((c) => c.sourceName)).toEqual([
      "rss:notes.example.org",
      "rss:notes.example.org",
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.feedUrl).toBe(RSS_FEED_URL);
    expect(failures[0]!.error).toBeInstanceOf(SourceError);
    expect(failures[0]!.error).toMatchObject({
      source: "rss:blog.example.com",
    });
  });

  it("isolates an unsafe feed URL without touching the network for it", async () => {
    const { fetchImpl, captured } = makeFetch(feedRouter);
    const candidates = await createRssAdapter({
      now,
      feeds: ["http://127.0.0.1/feed.xml", ATOM_FEED_URL],
    }).fetchCandidates(options(fetchImpl));

    expect(captured.map((r) => r.url)).toEqual([ATOM_FEED_URL]);
    expect(candidates).toHaveLength(2);
  });

  it("throws SourceError naming every feed when all of them fail", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() =>
      createRssAdapter({
        now,
        feeds: [RSS_FEED_URL, ATOM_FEED_URL],
      }).fetchCandidates(options(fetchImpl)),
    );

    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "rss" });
    expect(String(err)).toContain(RSS_FEED_URL);
    expect(String(err)).toContain(ATOM_FEED_URL);
  });

  it("throws SourceError when the only feed is neither RSS nor Atom", async () => {
    const { fetchImpl } = makeFetch(() =>
      xmlResponse("<html><body>not a feed</body></html>"),
    );
    const err = await rejection(() =>
      createRssAdapter({ now, feeds: [RSS_FEED_URL] }).fetchCandidates(
        options(fetchImpl),
      ),
    );
    expect(err).toBeInstanceOf(SourceError);
    expect(err).toMatchObject({ source: "rss" });
  });

  it("returns nothing and makes no request when configured with no feeds", async () => {
    const { fetchImpl, captured } = makeFetch(feedRouter);
    const candidates = await createRssAdapter({
      now,
      feeds: [],
    }).fetchCandidates(options(fetchImpl));
    expect(candidates).toEqual([]);
    expect(captured).toEqual([]);
  });
});

describe("defaultAdapters", () => {
  it("returns the four built-in adapters in a stable order", () => {
    expect(defaultAdapters().map((a) => a.name)).toEqual([
      "hn",
      "lobsters",
      "arxiv",
      "rss",
    ]);
  });

  it("omits adapters disabled with false", () => {
    expect(
      defaultAdapters({ lobsters: false, arxiv: false }).map((a) => a.name),
    ).toEqual(["hn", "rss"]);
  });

  it("exposes safe https default RSS feeds with unique hosts", () => {
    expect(DEFAULT_RSS_FEEDS.length).toBeGreaterThan(0);
    const hosts = DEFAULT_RSS_FEEDS.map((feed) => new URL(feed).host);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const feed of DEFAULT_RSS_FEEDS) {
      expect(new URL(feed).protocol).toBe("https:");
    }
  });

  it("fetches the default RSS feeds when none are supplied", async () => {
    const { fetchImpl, captured } = makeFetch(() => xmlResponse(ATOM_FEED));
    const rss = defaultAdapters({ rss: { now } }).find((a) => a.name === "rss");
    await rss!.fetchCandidates(options(fetchImpl));
    expect(captured.map((r) => r.url)).toEqual([...DEFAULT_RSS_FEEDS]);
  });

  it("passes per-adapter options through to the adapters", async () => {
    const { fetchImpl, captured } = makeFetch((req) =>
      req.url.startsWith("https://hn.algolia.com/")
        ? jsonResponse({ hits: [] })
        : xmlResponse(ATOM_FEED),
    );
    const adapters = defaultAdapters({
      hn: { now, minPoints: 300 },
      rss: { now, feeds: [ATOM_FEED_URL] },
    });

    const hn = adapters.find((a) => a.name === "hn");
    const rss = adapters.find((a) => a.name === "rss");
    await hn!.fetchCandidates(options(fetchImpl));
    await rss!.fetchCandidates(options(fetchImpl));

    const hnUrl = new URL(captured[0]!.url);
    expect(hnUrl.searchParams.get("numericFilters")).toBe(
      `created_at_i>${Math.floor(WINDOW_START / 1000)},points>300`,
    );
    expect(captured[1]!.url).toBe(ATOM_FEED_URL);
  });
});
