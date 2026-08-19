import { describe, expect, it } from "vitest";
import { ExtractionError } from "@til/core";
import {
  captionRequestUrl,
  captionTracksFrom,
  extractPlayerResponse,
  fetchYoutubeTranscript,
  needsProofOfOrigin,
  pickCaptionTrack,
  playabilityProblem,
  TRANSCRIPT_UNAVAILABLE,
  transcriptToText,
  videoTitleFrom,
} from "./youtube.js";

const VIDEO_ID = "dQw4w9WgXcQ";

/**
 * The live param set, verified 2026-08-12 — `signature`/`expire`/`sparams` are what
 * make the URL work, so tests assert they survive. `exp=xpe` is deliberately absent
 * here: that marker means the URL is proof-of-origin gated, and it has its own tests.
 */
const CAPTION_BASE =
  `https://www.youtube.com/api/timedtext?v=${VIDEO_ID}&ei=EI&caps=asr&opi=112496729` +
  `&xoaf=5&xowf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1786561750` +
  `&sparams=ip,ipbits,expire,v,ei,caps,opi&signature=862D9F6A&key=yt8&lang=en`;

interface FixtureOptions {
  captionTracks?: unknown;
  title?: string;
  /** Replaces the whole player-response assignment with something else. */
  playerJson?: string;
  playabilityStatus?: unknown;
}

/**
 * A watch page in the shape the real one has had for years: minified JSON assigned
 * to `ytInitialPlayerResponse` inside an inline script, with the caption list at
 * `captions.playerCaptionsTracklistRenderer.captionTracks`.
 *
 * Deliberately includes the things that break naive parsers — a `};` and a
 * `</script>` inside string literals, escaped quotes, and a second script after the
 * one we want.
 */
function watchPage(opts: FixtureOptions = {}): string {
  const player = {
    responseContext: { note: "a string with };  and </script> inside it" },
    playabilityStatus: opts.playabilityStatus ?? {
      status: "OK",
      playableInEmbed: true,
    },
    videoDetails: {
      videoId: VIDEO_ID,
      title: opts.title ?? 'Why "ownership" beats a garbage collector',
      lengthSeconds: "914",
      author: "Example Channel",
    },
    captions:
      opts.captionTracks === undefined
        ? undefined
        : {
            playerCaptionsTracklistRenderer: {
              captionTracks: opts.captionTracks,
            },
          },
  };
  const json = opts.playerJson ?? JSON.stringify(player);
  return `<!doctype html><html><head><title>${
    opts.title ?? "Why &quot;ownership&quot; beats a garbage collector"
  } - YouTube</title></head><body>
<script nonce="abc">var meta = {"unrelated":"object"};</script>
<script nonce="xyz">var ytInitialPlayerResponse = ${json};if (window.ytcsi) {window.ytcsi.tick("pr");}</script>
<script nonce="def">var ytInitialData = {"contents":{"twoColumnWatchNextResults":{}}};</script>
</body></html>`;
}

const ENGLISH_TRACK = {
  baseUrl: CAPTION_BASE,
  name: { simpleText: "English" },
  vssId: ".en",
  languageCode: "en",
  isTranslatable: true,
  trackName: "",
};

const AUTO_TRACK = {
  baseUrl: `${CAPTION_BASE}&kind=asr`,
  name: { runs: [{ text: "English (auto-generated)" }] },
  languageCode: "en",
  kind: "asr",
};

const GERMAN_TRACK = {
  baseUrl: `${CAPTION_BASE}&lang=de`,
  name: { simpleText: "Deutsch" },
  languageCode: "de",
};

const LONG_LINE =
  "The borrow checker is the part of the compiler that enforces ownership rules, and every value has exactly one owner.";

function json3Transcript(lines: readonly string[]): string {
  return JSON.stringify({
    wireMagic: "pb3",
    events: [
      { tStartMs: 0, dDurationMs: 1000, aAppend: 1 },
      ...lines.map((line, i) => ({
        tStartMs: i * 4000,
        dDurationMs: 4000,
        segs: line.split(" ").map((word, j) => ({
          utf8: j === 0 ? word : ` ${word}`,
          tOffsetMs: j * 100,
        })),
      })),
    ],
  });
}

function xmlTranscript(lines: readonly string[]): string {
  const body = lines
    .map(
      (line, i) =>
        `<text start="${i * 4}" dur="4">${line
          .replace(/&/g, "&amp;")
          .replace(/'/g, "&amp;#39;")}</text>`,
    )
    .join("");
  return `<?xml version="1.0" encoding="utf-8" ?><transcript>${body}</transcript>`;
}

/* ------------------------------------------------------------------- parsing */

describe("extractPlayerResponse", () => {
  it("lifts the player response out of a real-shaped watch page", () => {
    const parsed = extractPlayerResponse(
      watchPage({ captionTracks: [ENGLISH_TRACK] }),
    );
    expect(
      (parsed as { videoDetails: { videoId: string } }).videoDetails.videoId,
    ).toBe(VIDEO_ID);
  });

  it("is not fooled by `};` or `</script>` inside a string literal", () => {
    // A regex-based parser stops at the first `};` and produces invalid JSON here.
    const parsed = extractPlayerResponse(
      watchPage({ captionTracks: [ENGLISH_TRACK] }),
    );
    expect(captionTracksFrom(parsed)).toHaveLength(1);
  });

  it("returns null for a consent wall with no player response", () => {
    const html =
      "<!doctype html><html><body><h1>Before you continue to YouTube</h1><form>...</form></body></html>";
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("returns null when the assignment is truncated mid-object", () => {
    const html = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("returns null when the assignment is not JSON at all", () => {
    const html = `<script>var ytInitialPlayerResponse = {not json, just words};</script>`;
    expect(extractPlayerResponse(html)).toBeNull();
  });

  it("skips a bare mention of the marker and finds the real assignment", () => {
    const html = `<p>ytInitialPlayerResponse is where the data lives, further down the page.</p>${watchPage(
      { captionTracks: [ENGLISH_TRACK] },
    )}`;
    expect(captionTracksFrom(extractPlayerResponse(html))).toHaveLength(1);
  });

  it("returns null for an empty page", () => {
    expect(extractPlayerResponse("")).toBeNull();
  });
});

describe("extractPlayerResponse — escaping", () => {
  it("decodes the \\u0026-escaped baseUrl the raw HTML actually carries", () => {
    // Verified 2026-08-12: the served HTML has `...timedtext?v=x&lang=en`.
    // A regex that lifts baseUrl out of the markup yields literal `&`
    // separators and a URL that does not fetch; JSON.parse is what fixes it.
    const html = `<script>var ytInitialPlayerResponse = {"captions":{"playerCaptionsTracklistRenderer":{"captionTracks":[{"baseUrl":"https://www.youtube.com/api/timedtext?v=x\\u0026lang=en\\u0026signature=S","languageCode":"en"}]}}};</script>`;
    const tracks = captionTracksFrom(extractPlayerResponse(html));
    expect(tracks[0]?.baseUrl).toBe(
      "https://www.youtube.com/api/timedtext?v=x&lang=en&signature=S",
    );
    expect(tracks[0]?.baseUrl).not.toContain("u0026");
  });
});

describe("captionTracksFrom", () => {
  it("reads baseUrl, languageCode, kind and both name shapes", () => {
    const tracks = captionTracksFrom(
      extractPlayerResponse(
        watchPage({ captionTracks: [ENGLISH_TRACK, AUTO_TRACK] }),
      ),
    );
    expect(tracks).toEqual([
      { baseUrl: CAPTION_BASE, languageCode: "en", name: "English" },
      {
        baseUrl: `${CAPTION_BASE}&kind=asr`,
        languageCode: "en",
        kind: "asr",
        name: "English (auto-generated)",
      },
    ]);
  });

  it("is empty when the video has no captions object at all", () => {
    expect(captionTracksFrom(extractPlayerResponse(watchPage()))).toEqual([]);
  });

  it("is empty when captionTracks is present but empty", () => {
    expect(
      captionTracksFrom(
        extractPlayerResponse(watchPage({ captionTracks: [] })),
      ),
    ).toEqual([]);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "captions"],
    ["a number", 7],
    ["an array", [1, 2]],
    ["an unrelated object", { player: {} }],
    [
      "captionTracks as an object",
      { captions: { playerCaptionsTracklistRenderer: { captionTracks: {} } } },
    ],
    [
      "a renamed renderer",
      { captions: { somethingNewRenderer: { captionTracks: [] } } },
    ],
  ])("survives %s without throwing", (_label, input) => {
    // Every shape here is "YouTube changed something". None may crash the ingest.
    expect(() => captionTracksFrom(input)).not.toThrow();
    expect(captionTracksFrom(input)).toEqual([]);
  });

  it("drops entries with no baseUrl rather than inventing one", () => {
    expect(
      captionTracksFrom({
        captions: {
          playerCaptionsTracklistRenderer: {
            captionTracks: [{ languageCode: "en" }, ENGLISH_TRACK, null, "x"],
          },
        },
      }),
    ).toEqual([{ baseUrl: CAPTION_BASE, languageCode: "en", name: "English" }]);
  });
});

describe("pickCaptionTrack", () => {
  it("prefers a human-authored English track over the auto one", () => {
    // Auto-captions have no punctuation, which measurably worsens the digest.
    expect(
      pickCaptionTrack([AUTO_TRACK, ENGLISH_TRACK].map(toTrack))?.kind,
    ).toBeUndefined();
  });

  it("prefers any human-authored track over an auto one", () => {
    expect(
      pickCaptionTrack([AUTO_TRACK, GERMAN_TRACK].map(toTrack))?.languageCode,
    ).toBe("de");
  });

  it("takes auto English when that is all there is", () => {
    expect(pickCaptionTrack([AUTO_TRACK].map(toTrack))?.kind).toBe("asr");
  });

  it("prefers English over another language among auto tracks", () => {
    const autoGerman = { ...GERMAN_TRACK, kind: "asr" };
    expect(
      pickCaptionTrack([autoGerman, AUTO_TRACK].map(toTrack))?.languageCode,
    ).toBe("en");
  });

  it("is null for no tracks", () => {
    expect(pickCaptionTrack([])).toBeNull();
  });
});

function toTrack(raw: {
  baseUrl: string;
  languageCode: string;
  kind?: string;
}): { baseUrl: string; languageCode: string; kind?: string } {
  return raw;
}

describe("captionRequestUrl", () => {
  it("keeps the signed query and asks for fmt=json3", () => {
    const url = new URL(captionRequestUrl(CAPTION_BASE) ?? "");
    expect(url.searchParams.get("fmt")).toBe("json3");
    // The signature and expiry are what make the URL work; dropping them 403s.
    expect(url.searchParams.get("signature")).toBe("862D9F6A");
    expect(url.searchParams.get("expire")).toBe("1786561750");
    expect(url.searchParams.get("sparams")).toContain("ipbits");
  });

  it("replaces an fmt the page already set", () => {
    const url = new URL(captionRequestUrl(`${CAPTION_BASE}&fmt=srv3`) ?? "");
    expect(url.searchParams.getAll("fmt")).toEqual(["json3"]);
  });

  it("decodes an html-escaped baseUrl", () => {
    // The page JSON sometimes carries &amp; between params.
    const url = captionRequestUrl(
      "https://www.youtube.com/api/timedtext?v=x&amp;lang=en",
    );
    expect(new URL(url ?? "").searchParams.get("lang")).toBe("en");
  });

  it.each([
    ["https://evil.test/api/timedtext?v=x", "a non-youtube host"],
    ["https://youtube.com.evil.test/api/timedtext", "a suffix attack"],
    ["http://169.254.169.254/api/timedtext", "the metadata IP"],
    ["http://localhost:9000/api/timedtext", "localhost"],
    ["file:///etc/passwd", "a non-http scheme"],
    ["not-a-url", "unparseable"],
    ["", "empty"],
  ])("refuses %s (%s)", (baseUrl, _why) => {
    // baseUrl is read out of page JSON. If this ever returns non-null for a host
    // we do not control, the watch page has picked our Worker's fetch target.
    expect(captionRequestUrl(baseUrl)).toBeNull();
  });

  it("accepts a youtube subdomain", () => {
    expect(
      captionRequestUrl("https://m.youtube.com/api/timedtext?v=x"),
    ).toContain("m.youtube.com");
  });
});

describe("playabilityProblem", () => {
  it("reports the bot check, which is the dominant failure from a datacenter IP", () => {
    // Verified live 2026-08-12: HTTP 200, valid JSON, no `captions` key at all.
    const problem = playabilityProblem({
      playabilityStatus: {
        status: "LOGIN_REQUIRED",
        reason: "Sign in to confirm you’re not a bot",
        contextParams: "Q0FFU0FnZ0M=",
      },
    });
    expect(problem).toBe("LOGIN_REQUIRED: Sign in to confirm you’re not a bot");
  });

  it("falls back to the error screen's reason", () => {
    expect(
      playabilityProblem({
        playabilityStatus: {
          status: "UNPLAYABLE",
          errorScreen: {
            playerErrorMessageRenderer: {
              reason: { simpleText: "This video is not available" },
            },
          },
        },
      }),
    ).toBe("UNPLAYABLE: This video is not available");
  });

  it("reports a bare status with no reason", () => {
    expect(playabilityProblem({ playabilityStatus: { status: "ERROR" } })).toBe(
      "ERROR",
    );
  });

  it("truncates a long reason — it lands in a DB column and on screen", () => {
    const problem = playabilityProblem({
      playabilityStatus: { status: "ERROR", reason: "x".repeat(500) },
    });
    expect(problem?.length).toBe(200);
  });

  it.each([
    ["OK", { playabilityStatus: { status: "OK" } }],
    ["no playabilityStatus", { videoDetails: {} }],
    ["null", null],
    ["a string", "nope"],
    ["a status that is not a string", { playabilityStatus: { status: 7 } }],
  ])("is null for %s", (_label, input) => {
    expect(playabilityProblem(input)).toBeNull();
  });
});

describe("needsProofOfOrigin", () => {
  it("spots the exp=xpe marker on a watch-page caption url", () => {
    // Verified 2026-08-12: fetching one of these returns HTTP 200 with a
    // zero-length body for every fmt, so it is checked before spending a request.
    expect(needsProofOfOrigin(`${CAPTION_BASE}&exp=xpe&xoaf=5`)).toBe(true);
    expect(
      needsProofOfOrigin("https://www.youtube.com/api/timedtext?exp=xpe"),
    ).toBe(true);
    expect(needsProofOfOrigin(`${CAPTION_BASE}&exp=xpe`)).toBe(true);
  });

  it.each([
    [CAPTION_BASE, "a plain signed url"],
    [`${CAPTION_BASE}&exp=xpb`, "a different exp value"],
    [`${CAPTION_BASE}&myexp=xpe`, "a param that merely ends in exp"],
    [`${CAPTION_BASE}&exp=xpeXX`, "a longer exp value"],
    ["", "empty"],
  ])("is false for %s (%s)", (baseUrl, _why) => {
    expect(needsProofOfOrigin(baseUrl)).toBe(false);
  });
});

describe("transcriptToText", () => {
  it("joins fmt=json3 segments into prose", () => {
    const text = transcriptToText(
      json3Transcript(["hello there", "world again"]),
    );
    expect(text).toBe("hello there world again");
  });

  it("ignores json3 events that carry no segs", () => {
    // The first event of a real payload is usually a bare aAppend marker.
    expect(transcriptToText(json3Transcript(["only line here"]))).toBe(
      "only line here",
    );
  });

  it("reads the XML formats too, so a changed fmt param costs nothing", () => {
    const text = transcriptToText(xmlTranscript(["it's here", "and here"]));
    expect(text).toBe("it's here and here");
  });

  it("reads srv3, whose cues are <p t= d=> rather than <text start= dur=>", () => {
    // Some clients hand back a baseUrl that already pins fmt=srv3.
    expect(
      transcriptToText(
        `<?xml version="1.0" encoding="utf-8" ?><timedtext format="3">\n<body>\n<p t="1360" d="1680">first cue</p><p t="3040" d="1200">second cue</p></body></timedtext>`,
      ),
    ).toBe("first cue second cue");
  });

  it("decodes the double-encoded entities the XML payload carries", () => {
    // `&amp;#39;` — one decode pass leaves `&#39;` on screen.
    expect(
      transcriptToText(
        `<transcript><text start="0">don&amp;#39;t &amp;amp; won&amp;#39;t</text></transcript>`,
      ),
    ).toBe("don't & won't");
  });

  it("collapses the hard newlines caption cues carry mid-sentence", () => {
    expect(
      transcriptToText(
        `<transcript><text start="0">first half\nsecond half</text></transcript>`,
      ),
    ).toBe("first half second half");
  });

  it("drops timings — the digest wants prose, not a subtitle file", () => {
    const text = transcriptToText(json3Transcript(["a line"])) ?? "";
    expect(text).not.toContain("tStartMs");
    expect(text).not.toMatch(/\d{3,}/);
  });

  it.each([
    ["", "an empty body"],
    ["   ", "whitespace"],
    ["<html><body>Sign in</body></html>", "an html error page"],
    ['{"events":[]}', "json3 with no events"],
    ['{"events":[{"segs":[]}]}', "json3 with empty segs"],
    ["<transcript></transcript>", "empty xml"],
    ["{not json", "malformed json"],
    ['{"wireMagic":"pb3"}', "json3 with no events key"],
  ])("is null for %s (%s)", (body, _why) => {
    expect(transcriptToText(body)).toBeNull();
  });
});

describe("videoTitleFrom", () => {
  it("prefers the player response's own title", () => {
    const html = watchPage({ captionTracks: [ENGLISH_TRACK] });
    expect(videoTitleFrom(html, extractPlayerResponse(html))).toBe(
      'Why "ownership" beats a garbage collector',
    );
  });

  it("falls back to the page title, without the ' - YouTube' suffix", () => {
    const html = `<html><head><title>A talk about caches &amp; queues - YouTube</title></head></html>`;
    expect(videoTitleFrom(html, null)).toBe("A talk about caches & queues");
  });

  it("is undefined when there is no title anywhere", () => {
    expect(videoTitleFrom("<html></html>", null)).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ fetching */

interface StubReply {
  status?: number;
  body?: string | ReadableStream;
  headers?: Record<string, string>;
  throws?: Error;
}

/** Answers the watch page first, then the caption request. */
function stubFetch(replies: readonly StubReply[]): {
  fetchImpl: typeof fetch;
  urls: string[];
} {
  const urls: string[] = [];
  let i = 0;
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const reply = replies[i] ?? replies[replies.length - 1] ?? {};
    i += 1;
    if (reply.throws) throw reply.throws;
    return new Response((reply.body ?? "") as BodyInit, {
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const LONG_TRANSCRIPT = [LONG_LINE, LONG_LINE, "And that is the whole trick."];

describe("fetchYoutubeTranscript — happy path", () => {
  it("fetches the watch page, then the caption track, and returns prose", async () => {
    const { fetchImpl, urls } = stubFetch([
      { body: watchPage({ captionTracks: [ENGLISH_TRACK, AUTO_TRACK] }) },
      { body: json3Transcript(LONG_TRANSCRIPT) },
    ]);

    const out = await fetchYoutubeTranscript(VIDEO_ID, fetchImpl);

    expect(out.text).toContain("borrow checker");
    expect(out.text).toContain("And that is the whole trick.");
    expect(out.title).toBe('Why "ownership" beats a garbage collector');
    // The human-authored track won, not the auto one.
    expect(out.track.kind).toBeUndefined();

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain(`/watch?v=${VIDEO_ID}`);
    expect(urls[0]).toContain("has_verified=1");
    // `bpctr` was verified dead on 2026-08-12; sending a param known not to work is
    // cargo cult, so it is deliberately absent.
    expect(urls[0]).not.toContain("bpctr");
    expect(urls[1]).toContain("/api/timedtext");
    expect(urls[1]).toContain("fmt=json3");
    // The signed params have to survive into the request or it 404s.
    expect(urls[1]).toContain("signature=862D9F6A");
  });

  it("works when the caption endpoint answers with XML instead of json3", async () => {
    const { fetchImpl } = stubFetch([
      { body: watchPage({ captionTracks: [ENGLISH_TRACK] }) },
      { body: xmlTranscript(LONG_TRANSCRIPT) },
    ]);
    const out = await fetchYoutubeTranscript(VIDEO_ID, fetchImpl);
    expect(out.text).toContain("borrow checker");
  });

  it("sends a browser user-agent and an English accept-language", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(
        seen.length === 1
          ? watchPage({ captionTracks: [ENGLISH_TRACK] })
          : json3Transcript(LONG_TRANSCRIPT),
      );
    }) as unknown as typeof fetch;

    await fetchYoutubeTranscript(VIDEO_ID, fetchImpl);
    for (const init of seen) {
      const headers = init.headers as Record<string, string>;
      expect(headers["user-agent"]).toContain("Mozilla/5.0");
      expect(headers["accept-language"]).toContain("en");
      // Never unbounded: every request carries a timeout signal.
      expect(init.signal).toBeDefined();
    }
  });
});

describe("fetchYoutubeTranscript — degradation", () => {
  /** Every failure is the same recognisable ExtractionError, never a crash. */
  async function expectUnavailable(
    replies: readonly StubReply[],
    reason: RegExp,
  ): Promise<void> {
    const { fetchImpl } = stubFetch(replies);
    const error = await fetchYoutubeTranscript(VIDEO_ID, fetchImpl).then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(ExtractionError);
    expect((error as Error).message).toContain(TRANSCRIPT_UNAVAILABLE);
    expect((error as Error).message).toMatch(/experimental/);
    expect((error as Error).message).toMatch(reason);
  }

  it("no captions on the video", async () => {
    await expectUnavailable([{ body: watchPage() }], /no caption track/);
  });

  it("an empty caption track list", async () => {
    await expectUnavailable(
      [{ body: watchPage({ captionTracks: [] }) }],
      /no caption track/,
    );
  });

  it("the bot check — reported as YouTube's refusal, not as 'no subtitles'", async () => {
    // The dominant real-world outcome for a Worker: HTTP 200, parseable player JSON,
    // `LOGIN_REQUIRED`, and no captions key. Calling that "no caption track" would
    // hide the actual problem behind a plausible-looking one.
    await expectUnavailable(
      [
        {
          body: watchPage({
            playabilityStatus: {
              status: "LOGIN_REQUIRED",
              reason: "Sign in to confirm you’re not a bot",
            },
          }),
        },
      ],
      /YouTube refused to play it — LOGIN_REQUIRED: Sign in to confirm/,
    );
  });

  it("a proof-of-origin gated caption url, without spending the request", async () => {
    const { fetchImpl, urls } = stubFetch([
      {
        body: watchPage({
          captionTracks: [
            { ...ENGLISH_TRACK, baseUrl: `${CAPTION_BASE}&exp=xpe` },
          ],
        }),
      },
    ]);
    await expect(fetchYoutubeTranscript(VIDEO_ID, fetchImpl)).rejects.toThrow(
      /proof-of-origin token/,
    );
    // One fetch only — an exp=xpe url returns an empty 200, so asking is pointless.
    expect(urls).toHaveLength(1);
  });

  it("a consent or bot wall instead of the watch page", async () => {
    // The realistic failure for a datacenter IP: HTTP 200, a cookie notice, no
    // player response anywhere in it.
    await expectUnavailable(
      [
        {
          body: "<html><body><h1>Before you continue to YouTube</h1></body></html>",
        },
      ],
      /consent or bot check/,
    );
  });

  it("markup changed so the player response no longer parses", async () => {
    await expectUnavailable(
      [{ body: `<script>var ytInitialPlayerResponse = {"captions":` }],
      /no player data/,
    );
  });

  it("the caption list moved to a key we do not know", async () => {
    await expectUnavailable(
      [
        {
          body: `<script>var ytInitialPlayerResponse = ${JSON.stringify({
            captions: { brandNewRenderer: { tracks: [ENGLISH_TRACK] } },
          })};</script>`,
        },
      ],
      /no caption track/,
    );
  });

  it("the watch page 429s", async () => {
    await expectUnavailable([{ status: 429, body: "slow down" }], /HTTP 429/);
  });

  it("the watch page fetch rejects outright", async () => {
    await expectUnavailable(
      [{ throws: new Error("Network connection lost.") }],
      /could not load the watch page.*Network connection lost/,
    );
  });

  it("the watch page fetch times out", async () => {
    // AbortSignal.timeout rejects with an AbortError; it must not escape raw.
    const abort = new Error("The operation was aborted due to timeout");
    abort.name = "TimeoutError";
    await expectUnavailable(
      [{ throws: abort }],
      /could not load the watch page/,
    );
  });

  it("the caption fetch 403s — the shape of a token-gated request", async () => {
    await expectUnavailable(
      [
        { body: watchPage({ captionTracks: [ENGLISH_TRACK] }) },
        { status: 403 },
      ],
      /caption track returned HTTP 403/,
    );
  });

  it("the caption track answers 200 with an empty body", async () => {
    await expectUnavailable(
      [{ body: watchPage({ captionTracks: [ENGLISH_TRACK] }) }, { body: "" }],
      /came back empty/,
    );
  });

  it("the caption track answers with an html error page", async () => {
    await expectUnavailable(
      [
        { body: watchPage({ captionTracks: [ENGLISH_TRACK] }) },
        { body: "<html><body>Sorry for the interruption</body></html>" },
      ],
      /came back empty/,
    );
  });

  it("the transcript is too short to be worth an LLM call", async () => {
    await expectUnavailable(
      [
        { body: watchPage({ captionTracks: [ENGLISH_TRACK] }) },
        { body: json3Transcript(["hi there"]) },
      ],
      /too short \(8 chars\)/,
    );
  });

  it("the caption baseUrl points somewhere that is not YouTube", async () => {
    // A poisoned page must not turn into a fetch at a host of its choosing.
    const { fetchImpl, urls } = stubFetch([
      {
        body: watchPage({
          captionTracks: [
            { ...ENGLISH_TRACK, baseUrl: "http://169.254.169.254/latest" },
          ],
        }),
      },
    ]);
    await expect(fetchYoutubeTranscript(VIDEO_ID, fetchImpl)).rejects.toThrow(
      /not a usable YouTube url/,
    );
    // One fetch only: the watch page. The caption request never happened.
    expect(urls).toHaveLength(1);
  });

  it("an oversized watch page is cut off rather than buffered whole", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 5 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await expectUnavailable(
      [{ body: stream }],
      /could not load the watch page.*cap/,
    );
  });

  it("an oversized caption body is cut off too", async () => {
    const chunk = new TextEncoder().encode("y".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > 3 * 1024 * 1024) {
          controller.close();
          return;
        }
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    await expectUnavailable(
      [
        { body: watchPage({ captionTracks: [ENGLISH_TRACK] }) },
        { body: stream },
      ],
      /could not load the caption track.*cap/,
    );
  });
});
