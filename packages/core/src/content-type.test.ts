import { describe, expect, it } from "vitest";
import {
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  detectContentTypeFromUrl,
  isContentType,
  isPdfMediaType,
  isYoutubeHost,
  normalizeContentType,
  refineContentType,
  youtubeVideoId,
  youtubeWatchUrl,
} from "./content-type.js";

describe("isContentType / normalizeContentType", () => {
  it("accepts exactly the three known values", () => {
    for (const t of CONTENT_TYPES) expect(isContentType(t)).toBe(true);
    expect(CONTENT_TYPES).toEqual(["article", "pdf", "video"]);
  });

  it.each([
    ["Article", "capitalised"],
    ["", "empty"],
    ["audio", "unknown kind"],
    [null, "null"],
    [undefined, "undefined"],
    [7, "a number"],
  ])("rejects %s (%s)", (raw, _why) => {
    expect(isContentType(raw)).toBe(false);
    // A row written by hand, or by a future version, still has to render.
    expect(normalizeContentType(raw)).toBe("article");
  });

  it("defaults to article — what every pre-P25 row means", () => {
    expect(DEFAULT_CONTENT_TYPE).toBe("article");
    expect(normalizeContentType("pdf")).toBe("pdf");
    expect(normalizeContentType("video")).toBe("video");
  });
});

describe("isYoutubeHost", () => {
  it.each([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "gaming.youtube.com",
    "YouTube.com",
    "youtu.be",
    "www.youtube-nocookie.com",
  ])("%s is youtube", (host) => {
    expect(isYoutubeHost(host)).toBe(true);
  });

  it.each([
    ["notyoutube.com", "no dot before the suffix"],
    ["myyoutube.com", "no dot before the suffix"],
    ["youtube.com.evil.test", "suffix attack"],
    ["youtube.co", "close but not it"],
    ["evil-youtube.com", "hyphenated lookalike"],
    ["googlevideo.com", "a different google host"],
    ["", "empty"],
  ])("%s is not (%s)", (host) => {
    // This predicate is the allowlist a caption baseUrl is checked against, so a
    // false positive here is an SSRF, not a cosmetic bug.
    expect(isYoutubeHost(host)).toBe(false);
  });
});

describe("youtubeVideoId", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://music.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ?t=42", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/live/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["http://www.youtube.com/watch?v=dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    // Extra params, and v= not first.
    [
      "https://www.youtube.com/watch?list=PL1&v=dQw4w9WgXcQ&index=2",
      "dQw4w9WgXcQ",
    ],
    // Ids carry - and _.
    ["https://www.youtube.com/watch?v=a-b_c-d_e-f", "a-b_c-d_e-f"],
  ])("reads %s", (url, expected) => {
    expect(youtubeVideoId(url)).toBe(expected);
  });

  it.each([
    ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", "lookalike host"],
    ["https://myyoutube.com/watch?v=dQw4w9WgXcQ", "lookalike host"],
    ["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "suffix attack"],
    ["https://evil.test/youtube.com/watch?v=dQw4w9WgXcQ", "host in the path"],
    ["https://youtu.be.evil.test/dQw4w9WgXcQ", "youtu.be suffix attack"],
    ["https://www.youtube.com/watch", "watch with no v"],
    ["https://www.youtube.com/watch?v=", "empty v"],
    ["https://www.youtube.com/watch?v=ab", "id too short to be one"],
    ["https://www.youtube.com/watch?v=has%20space", "id with a space"],
    ["https://www.youtube.com/watch?v=has/slash", "id with a slash"],
    ["https://www.youtube.com/", "channel-less root"],
    ["https://www.youtube.com/@someone", "a channel"],
    ["https://www.youtube.com/playlist?list=PL1", "a playlist"],
    ["https://www.youtube.com/results?search_query=x", "search results"],
    ["https://www.youtube.com/shorts/", "shorts with no id"],
    ["https://www.youtube.com/shorts/a/b", "too many segments"],
    ["https://youtu.be/", "youtu.be with no id"],
    ["https://youtu.be/a/b", "youtu.be with two segments"],
    ["javascript:alert(1)//youtube.com/watch?v=dQw4w9WgXcQ", "non-http scheme"],
    ["not-a-url", "not a url at all"],
    ["", "empty string"],
  ])("rejects %s (%s)", (url) => {
    expect(youtubeVideoId(url)).toBeNull();
  });

  it("uppercases in the host are still youtube", () => {
    expect(youtubeVideoId("https://WWW.YouTube.COM/watch?v=dQw4w9WgXcQ")).toBe(
      "dQw4w9WgXcQ",
    );
  });

  it("builds a watch url that round-trips", () => {
    const url = youtubeWatchUrl("dQw4w9WgXcQ");
    expect(url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(youtubeVideoId(url)).toBe("dQw4w9WgXcQ");
  });
});

describe("detectContentTypeFromUrl", () => {
  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/abcdefghijk",
  ])("%s is video", (url) => {
    expect(detectContentTypeFromUrl(url)).toBe("video");
  });

  it.each([
    "https://example.test/paper.pdf",
    "https://example.test/paper.PDF",
    "https://example.test/a/b/paper.pdf?download=1",
    "https://example.test/a/b/paper.pdf#page=3",
    "https://example.test/my%20paper.pdf",
    // A percent-encoded extension is still an extension.
    "https://example.test/paper%2Epdf",
  ])("%s is pdf", (url) => {
    expect(detectContentTypeFromUrl(url)).toBe("pdf");
  });

  it.each([
    ["https://example.test/post", "a plain page"],
    ["https://example.test/pdf", "the word pdf as a path"],
    ["https://example.test/pdf/viewer", "pdf as a directory"],
    ["https://example.test/notes.pdf.html", "pdf mid-filename"],
    ["https://example.test/x?file=paper.pdf", "pdf only in the query"],
    ["https://example.test/x#paper.pdf", "pdf only in the fragment"],
    ["https://notyoutube.com/watch?v=dQw4w9WgXcQ", "youtube lookalike"],
    ["https://www.youtube.com/@someone", "a youtube page that is not a video"],
    ["not-a-url", "unparseable"],
  ])("%s is article (%s)", (url) => {
    expect(detectContentTypeFromUrl(url)).toBe("article");
  });
});

describe("isPdfMediaType", () => {
  it.each([
    "application/pdf",
    "application/pdf; charset=binary",
    "APPLICATION/PDF",
    " application/pdf ",
    "application/x-pdf",
  ])("%s is a pdf media type", (header) => {
    expect(isPdfMediaType(header)).toBe(true);
  });

  it.each([
    ["text/html", "html"],
    ["text/html; charset=utf-8", "html with charset"],
    ["application/pdfx", "a longer type"],
    ["application/json", "json"],
    ["", "empty"],
    [null, "absent"],
    [undefined, "undefined"],
  ])("%s is not (%s)", (header, _why) => {
    expect(isPdfMediaType(header)).toBe(false);
  });
});

describe("refineContentType", () => {
  it("promotes an article guess when the server serves a pdf", () => {
    // arxiv.org/pdf/2401.00001 — extensionless, still a pdf.
    expect(refineContentType("article", "application/pdf")).toBe("pdf");
  });

  it("demotes a pdf guess when the server serves html", () => {
    // A `.pdf` link behind a landing page or a consent interstitial.
    expect(refineContentType("pdf", "text/html; charset=utf-8")).toBe(
      "article",
    );
  });

  it("keeps a pdf guess the server confirms", () => {
    expect(refineContentType("pdf", "application/pdf")).toBe("pdf");
  });

  it("keeps an article guess the server does not contradict", () => {
    expect(refineContentType("article", "text/html")).toBe("article");
    expect(refineContentType("article", null)).toBe("article");
  });

  it("never touches a video guess — that path never consults a header", () => {
    expect(refineContentType("video", "application/pdf")).toBe("video");
    expect(refineContentType("video", "text/html")).toBe("video");
    expect(refineContentType("video", null)).toBe("video");
  });
});
