import { describe, expect, it } from "vitest";
import { entries, settings } from "@til/db";
import { eq, sql } from "drizzle-orm";
import type { Extractor } from "@til/core";
import { buildTestApp, insertEntry, makeStubLLM } from "./test-harness.js";
import type { TestOverrides } from "./test-harness.js";
import { PDF_NEEDS_CLOUD } from "./ingest.js";
import { TRANSCRIPT_UNAVAILABLE } from "./youtube.js";
import type { EntryDTO, EntryDetailDTO } from "./dto.js";

const VIDEO_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const PDF_URL = "https://example.test/papers/attention.pdf";
const LONG_LINE =
  "The borrow checker is the part of the compiler that enforces ownership rules, and every value has exactly one owner. ";

async function withSettings(t: ReturnType<typeof buildTestApp>): Promise<void> {
  await t.deps.db.insert(settings).values({
    id: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-live-1234",
    cfAccountId: "acc",
    cfGatewayId: "gw",
    cfAigToken: null,
    createdAt: 1,
    updatedAt: 1,
  });
}

/** Saves a url, runs its ingest to completion, and hands back the stored row. */
async function ingest(url: string, overrides: TestOverrides = {}) {
  const t = buildTestApp(overrides);
  await withSettings(t);
  const res = await t.request("/api/entries", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const created = (await res.json()) as {
    id: string;
    status: string;
    contentType: string;
  };
  // The route answers before ingest runs, and must never be taken down by it.
  expect(res.status).toBe(201);
  await t.flush();
  const rows = await t.deps.db
    .select()
    .from(entries)
    .where(eq(entries.id, created.id));
  return { t, created, row: rows[0] };
}

describe("POST /api/entries — the url-phase guess", () => {
  it.each([
    [VIDEO_URL, "video"],
    ["https://youtu.be/dQw4w9WgXcQ", "video"],
    [PDF_URL, "pdf"],
    ["https://example.test/post", "article"],
    ["https://notyoutube.test/watch?v=dQw4w9WgXcQ", "article"],
  ])("stores and returns %s as %s", async (url, expected) => {
    // A fetch that fails immediately: ingest then never gets to refine the guess,
    // which is what lets this assert the *stored* guess — and doubles as proof the
    // badge survives a failed capture.
    const t = buildTestApp({
      fetchPage: async () => {
        throw new Error("offline");
      },
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json()) as { id: string; contentType: string };
    // Returned so the client's optimistic pending card is badged immediately.
    expect(body.contentType).toBe(expected);
    await t.flush();
    const rows = await t.deps.db
      .select()
      .from(entries)
      .where(eq(entries.id, body.id));
    expect(rows[0]?.contentType).toBe(expected);
    expect(rows[0]?.status).toBe("failed");
  });
});

describe("EntryDTO passthrough", () => {
  it("carries contentType on the list and the detail response", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "e-vid",
      url: VIDEO_URL,
      canonicalUrl: VIDEO_URL,
      contentType: "video",
    });

    const list = (await (await t.request("/api/entries")).json()) as {
      items: EntryDTO[];
    };
    expect(list.items[0]?.contentType).toBe("video");

    const detail = (await (
      await t.request("/api/entries/e-vid")
    ).json()) as EntryDetailDTO;
    expect(detail.contentType).toBe("video");
  });

  it("reads a row written before the column existed as an article", async () => {
    const t = buildTestApp();
    // The INSERT the app shipped before migration 0010 — the column is not named,
    // so the row takes the DEFAULT with no backfill.
    await t.deps.db.run(
      sql`INSERT INTO entries (id, url, canonical_url, tags, status, created_at, updated_at)
          VALUES ('e-legacy', 'https://example.test/old', 'https://example.test/old', '[]', 'ready', 1, 1)`,
    );
    const detail = (await (
      await t.request("/api/entries/e-legacy")
    ).json()) as EntryDetailDTO;
    expect(detail.contentType).toBe("article");
  });

  it("reads an unrecognised stored value as an article rather than leaking it", async () => {
    const t = buildTestApp();
    await t.deps.db.run(
      sql`INSERT INTO entries (id, url, canonical_url, tags, status, content_type, created_at, updated_at)
          VALUES ('e-odd', 'https://example.test/odd', 'https://example.test/odd', '[]', 'ready', 'audio', 1, 1)`,
    );
    const detail = (await (
      await t.request("/api/entries/e-odd")
    ).json()) as EntryDetailDTO;
    expect(detail.contentType).toBe("article");
  });

  it("a PATCH that only sets a mark leaves contentType alone", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "e-pdf", contentType: "pdf" });
    const res = await t.request("/api/entries/e-pdf", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: true }),
    });
    const body = (await res.json()) as EntryDetailDTO;
    expect(body).toMatchObject({ favorite: true, contentType: "pdf" });
  });
});

/* ---------------------------------------------------------------------- PDF */

/** A fetchPage that answers with PDF bytes, as the real one does for a PDF. */
function pdfFetchPage(bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46])) {
  return async () => ({
    html: "",
    finalUrl: PDF_URL,
    contentType: "pdf" as const,
    bytes,
  });
}

/** The cloud stack's extractor seam: an extractor that can convert a document. */
function pdfExtractor(markdown: string): {
  extractor: Extractor;
  calls: { bytes: number; url: string; mimeType: string }[];
} {
  const calls: { bytes: number; url: string; mimeType: string }[] = [];
  return {
    calls,
    extractor: {
      toMarkdown: async () => {
        throw new Error("the html path must not be taken for a pdf");
      },
      documentToMarkdown: async (bytes, url, mimeType) => {
        calls.push({ bytes: bytes.byteLength, url, mimeType });
        return { markdown, title: "Attention Is All You Need" };
      },
    },
  };
}

describe("PDF ingestion — local stack", () => {
  it("fails the entry with a readable sentence instead of crashing", async () => {
    // ReadabilityExtractor has no documentToMarkdown; the local stack cannot read a
    // PDF without a new runtime dependency, and says so.
    const { row } = await ingest(PDF_URL, {
      stack: "local",
      fetchPage: pdfFetchPage(),
      extractor: {
        toMarkdown: async () => ({ markdown: "unused", title: "unused" }),
      },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(PDF_NEEDS_CLOUD);
    expect(row?.error).toMatch(/TIL_STACK/);
    // The badge survives the failure, so the feed still says what this was.
    expect(row?.contentType).toBe("pdf");
    expect(row?.contentMarkdown).toBeNull();
  });

  it("is the failure even when the url gave no hint and the response did", async () => {
    // arxiv.org/pdf/2401.00001 — guessed article, served as a PDF.
    const { row } = await ingest("https://arxiv.test/pdf/2401.00001", {
      stack: "local",
      fetchPage: async () => ({
        html: "",
        finalUrl: "https://arxiv.test/pdf/2401.00001",
        contentType: "pdf" as const,
        bytes: new Uint8Array([0x25, 0x50]),
      }),
      extractor: { toMarkdown: async () => ({ markdown: "unused" }) },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toBe(PDF_NEEDS_CLOUD);
    expect(row?.contentType).toBe("pdf");
  });
});

describe("PDF ingestion — cloud stack", () => {
  it("routes the bytes through the document extractor and digests the markdown", async () => {
    const body = `# Attention Is All You Need\n\n${LONG_LINE.repeat(3)}`;
    const { extractor, calls } = pdfExtractor(body);
    const digested: string[] = [];
    const { row } = await ingest(PDF_URL, {
      stack: "cloud",
      fetchPage: pdfFetchPage(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
      extractor,
      llmFactory: () =>
        makeStubLLM({
          digest: async (markdown) => {
            digested.push(markdown);
            return {
              title: "Attention Is All You Need",
              summary: "A summary of the paper.",
              takeaway: "Attention replaces recurrence.",
              question: "What replaced attention?",
              tags: ["transformers", "attention", "nlp"],
            };
          },
        }),
    });

    expect(calls).toEqual([
      { bytes: 5, url: PDF_URL, mimeType: "application/pdf" },
    ]);
    expect(row?.status).toBe("ready");
    expect(row?.contentType).toBe("pdf");
    expect(row?.contentMarkdown).toBe(body);
    expect(row?.title).toBe("Attention Is All You Need");
    // The converted markdown went into the ordinary digest call — the same one an
    // article takes, and therefore the same untrusted-content framing.
    expect(digested).toEqual([body]);
  });

  it("fails readably when the conversion itself fails, and never crashes", async () => {
    const { row } = await ingest(PDF_URL, {
      stack: "cloud",
      fetchPage: pdfFetchPage(),
      extractor: {
        toMarkdown: async () => ({ markdown: "unused" }),
        documentToMarkdown: async () => {
          throw new Error(
            "This PDF has no extractable text — a scanned PDF is a picture of a page.",
          );
        },
      },
    });
    expect(row?.status).toBe("failed");
    expect(row?.error).toMatch(/no extractable text/);
    expect(row?.contentType).toBe("pdf");
  });

  it("takes the html path when a .pdf url turns out to serve html", async () => {
    // The URL guess said pdf; the response header demoted it. A landing page is an
    // article, and the stored content type has to end up saying so.
    const { row } = await ingest(PDF_URL, {
      stack: "cloud",
      fetchPage: async () => ({
        html: "<html><body>Sign in to download</body></html>",
        finalUrl: PDF_URL,
        contentType: "article" as const,
      }),
      extractor: {
        toMarkdown: async () => ({ markdown: "Sign in to download", title: "Login" }),
        documentToMarkdown: async () => {
          throw new Error("the pdf path must not be taken for html");
        },
      },
    });
    expect(row?.status).toBe("ready");
    expect(row?.contentType).toBe("article");
  });
});

/* ------------------------------------------------------------------- YouTube */

function watchPage(captionTracks: unknown): string {
  return `<!doctype html><html><head><title>Ownership, explained - YouTube</title></head><body>
<script>var ytInitialPlayerResponse = ${JSON.stringify({
    videoDetails: { videoId: "dQw4w9WgXcQ", title: "Ownership, explained" },
    captions:
      captionTracks === undefined
        ? undefined
        : { playerCaptionsTracklistRenderer: { captionTracks } },
  })};</script></body></html>`;
}

const TRACK = {
  baseUrl: "https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&lang=en&signature=A",
  name: { simpleText: "English" },
  languageCode: "en",
};

function transcriptBody(text: string): string {
  return JSON.stringify({
    events: [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: text }] }],
  });
}

/** A fetchImpl that answers the watch page then the caption track. */
function youtubeFetch(pages: readonly (string | Error)[]): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const next = pages[i] ?? pages[pages.length - 1] ?? "";
    i += 1;
    if (next instanceof Error) throw next;
    return new Response(next);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("YouTube ingestion", () => {
  it("turns captions into the entry's content and digests them normally", async () => {
    const transcript = LONG_LINE.repeat(3).trim();
    const { fetchImpl, urls } = youtubeFetch([
      watchPage([TRACK]),
      transcriptBody(transcript),
    ]);
    const digested: { markdown: string; title?: string; url: string }[] = [];

    const { row } = await ingest(VIDEO_URL, {
      fetchImpl,
      // Deliberately the local stack: transcript capture needs no cloud binding,
      // unlike PDFs.
      stack: "local",
      fetchPage: async () => {
        throw new Error("a video must not go through fetchPage");
      },
      extractor: {
        toMarkdown: async () => {
          throw new Error("a video must not go through the html extractor");
        },
      },
      llmFactory: () =>
        makeStubLLM({
          digest: async (markdown, meta) => {
            digested.push({ markdown, url: meta.url, ...(meta.title === undefined ? {} : { title: meta.title }) });
            return {
              title: "Ownership, explained",
              summary: "A talk about ownership.",
              takeaway: "One owner per value.",
              question: "How do lifetimes relate?",
              tags: ["rust", "ownership", "memory"],
            };
          },
        }),
    });

    expect(row?.status).toBe("ready");
    expect(row?.contentType).toBe("video");
    expect(row?.contentMarkdown).toBe(transcript);
    expect(row?.summary).toBe("A talk about ownership.");
    expect(row?.tags).toBe(JSON.stringify(["rust", "ownership", "memory"]));

    // The transcript flowed into the one framed digest entry point, carrying the
    // video's own title as the hint.
    expect(digested).toHaveLength(1);
    expect(digested[0]?.markdown).toBe(transcript);
    expect(digested[0]?.title).toBe("Ownership, explained");

    expect(urls[0]).toContain("/watch?v=dQw4w9WgXcQ");
    expect(urls[1]).toContain("/api/timedtext");
  });

  it.each([
    ["a video with no captions", [watchPage(undefined)], /no caption track/],
    [
      "a consent wall",
      ["<html><body>Before you continue to YouTube</body></html>"],
      /consent or bot check/,
    ],
    [
      "changed markup",
      ["<html><body><script>var ytInitialPlayerResponse = {</script></body></html>"],
      /no player data/,
    ],
    [
      "an empty caption response",
      [watchPage([TRACK]), ""],
      /came back empty/,
    ],
    [
      "a network failure",
      [new Error("Network connection lost.")],
      /could not load the watch page/,
    ],
    [
      "a timeout",
      [Object.assign(new Error("aborted due to timeout"), { name: "TimeoutError" })],
      /could not load the watch page/,
    ],
  ])("fails the entry readably for %s", async (_label, pages, reason) => {
    const { fetchImpl } = youtubeFetch(pages as readonly (string | Error)[]);
    const { row } = await ingest(VIDEO_URL, { fetchImpl });

    expect(row?.status).toBe("failed");
    expect(row?.error).toContain(TRANSCRIPT_UNAVAILABLE);
    // The copy the owner reads has to say this is experimental.
    expect(row?.error).toMatch(/experimental/);
    expect(row?.error).toMatch(reason);
    // Still badged as a video, so the failure is legible in the feed.
    expect(row?.contentType).toBe("video");
    expect(row?.contentMarkdown).toBeNull();
  });

  it("survives an oversized watch page without buffering it whole", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (sent > 5 * 1024 * 1024) {
              controller.close();
              return;
            }
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
        }),
      )) as unknown as typeof fetch;

    const { row } = await ingest(VIDEO_URL, { fetchImpl });
    expect(row?.status).toBe("failed");
    expect(row?.error).toContain(TRANSCRIPT_UNAVAILABLE);
  });

  it("a failed video can be reingested, and the badge is unchanged", async () => {
    const t = buildTestApp({
      fetchImpl: youtubeFetch([watchPage(undefined)]).fetchImpl,
    });
    await withSettings(t);
    await insertEntry(t.deps.db, {
      id: "e-retry",
      url: VIDEO_URL,
      canonicalUrl: VIDEO_URL,
      contentType: "video",
      status: "failed",
    });
    const res = await t.request("/api/entries/e-retry/reingest", { method: "POST" });
    expect(res.status).toBe(202);
    await t.flush();
    const rows = await t.deps.db
      .select()
      .from(entries)
      .where(eq(entries.id, "e-retry"));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.contentType).toBe("video");
  });
});
