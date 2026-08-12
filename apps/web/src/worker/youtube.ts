import {
  assertSafeUrl,
  ExtractionError,
  isYoutubeHost,
  youtubeWatchUrl,
} from "@til/core";
import { decodeEntities } from "./extractors.js";
import { readCappedText } from "./fetch-page.js";

/**
 * Keyless YouTube transcript capture (P25), and deliberately the most fragile
 * thing in this codebase.
 *
 * There is no supported API for captions without OAuth and video ownership, so
 * this does what every transcript library does: fetch the watch page, read the
 * caption track list out of the `ytInitialPlayerResponse` blob the page assigns
 * inline, then fetch that track. Every one of those steps is an implementation
 * detail of a page YouTube changes whenever it likes, and none of it is a promise
 * to anyone.
 *
 * So the design goal is not "work" — it is "fail in one recognisable way". Every
 * parse is optional-chained, every fetch is capped in bytes and bounded in time,
 * and every failure becomes one `ExtractionError` whose message says the feature
 * is experimental. The entry then shows that sentence and the owner can go watch
 * the video, which is a fine outcome; a thrown TypeError that takes out the ingest
 * queue would not be.
 *
 * ---------------------------------------------------------------------------
 * Verified against live YouTube on 2026-08-12. What is still true:
 *  - `var ytInitialPlayerResponse = {...}` is still assigned inline on the watch
 *    page, and the tracks are still at
 *    `captions.playerCaptionsTracklistRenderer.captionTracks[]`, each with
 *    `baseUrl`, `languageCode`, `name` (`{simpleText}` on the watch page,
 *    `{runs:[{text}]}` from other clients) and `kind: "asr"` present *only* on
 *    auto-generated tracks.
 *  - `baseUrl` arrives `&`-escaped in the raw HTML, which is exactly why this
 *    JSON.parses the blob instead of regexing the URL out of it.
 *  - `fmt=json3`, `srv1`/`srv3` and the bare `<transcript>` XML all still exist.
 *    A missing `captions` key means "this video has no captions" — normal, not an
 *    error.
 *
 * And the two things that make this feature usually *not* work, which is why the
 * failure copy matters more than the happy path:
 *  1. Bot detection. YouTube blocks datacenter IP space, and Cloudflare's egress is
 *     datacenter IP space. The response is an HTTP 200 whose player JSON parses
 *     fine, carries `playabilityStatus.status: "LOGIN_REQUIRED"`, reason "Sign in to
 *     confirm you're not a bot", and simply has no `captions` key. Read below: that
 *     status is reported verbatim rather than as "no captions", because otherwise
 *     every blocked video looks like a video with no subtitles.
 *  2. Proof-of-origin tokens. A watch-page `baseUrl` now carries `exp=xpe`, and
 *     fetching one without a `pot` token the browser's player JS computes returns
 *     HTTP 200 with a *zero-length body* for every `fmt`. `res.ok` passes and the
 *     parse then fails for no visible reason — so `exp=xpe` is detected up front
 *     and reported, instead of spending a request to learn nothing.
 *
 * There is a keyless path that does work today — POSTing to `/youtubei/v1/player`
 * with an `ANDROID_VR` or `IOS` client context returns caption URLs with no
 * `exp=xpe` — but it is a different design (an undocumented RPC with client
 * version strings to keep current) and it is not what this phase specified. It is
 * written up as a proposed follow-up rather than smuggled in here.
 */

/** The sentence the owner sees. Kept as a constant so the tests assert the copy. */
export const TRANSCRIPT_UNAVAILABLE =
  "YouTube transcript unavailable — this integration is experimental and breaks when YouTube changes";

const WATCH_PAGE_MAX_BYTES = 4 * 1024 * 1024;
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 12_000;

/** Same shape as fetch-page's floor, for the same reason: a two-line "transcript"
 * is not worth an LLM call, and "captions exist but are empty" should read as a
 * failure the owner can act on rather than a meaningless summary. */
const MIN_TRANSCRIPT_CHARS = 140;

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 TIL/0.1";

function transcriptUnavailable(reason: string): ExtractionError {
  return new ExtractionError(`${TRANSCRIPT_UNAVAILABLE} (${reason})`);
}

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  /** "asr" for machine-generated captions; absent for a human-authored track. */
  kind?: string;
  name?: string;
}

export interface YoutubeTranscript {
  /** The transcript as plain prose — what the digest prompt receives. */
  text: string;
  title?: string;
  /** Which track was used, for the log line. */
  track: CaptionTrack;
}

/* ------------------------------------------------------------------ parsing */

const PLAYER_RESPONSE_MARKERS = [
  "ytInitialPlayerResponse",
  // Seen on some watch page variants; harmless to try and cheap to keep.
  "ytInitialData",
];

/**
 * Lifts the player-response JSON out of the watch page.
 *
 * WHY a brace scanner and not a regex: the blob is minified JSON containing
 * `};`, `</script>` inside string literals, and escaped quotes, so every
 * `/= (\{.*?\});/` variant either stops early or swallows the rest of the page.
 * Counting braces while tracking string state is the only version that is correct
 * for input we do not control, and it is ~20 lines.
 */
export function extractPlayerResponse(html: string): unknown {
  for (const marker of PLAYER_RESPONSE_MARKERS) {
    let from = 0;
    for (;;) {
      const at = html.indexOf(marker, from);
      if (at === -1) break;
      from = at + marker.length;
      const open = html.indexOf("{", from);
      // A marker with no object within reach is a mention, not an assignment.
      if (open === -1 || open - from > 40) continue;
      const json = balancedSlice(html, open);
      if (json === null) continue;
      try {
        const parsed: unknown = JSON.parse(json);
        if (typeof parsed === "object" && parsed !== null) return parsed;
      } catch {
        // Not the assignment we wanted; keep looking.
      }
    }
  }
  return null;
}

/** The `{...}` starting at `open`, or null if it never closes inside the input. */
function balancedSlice(input: string, open: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < input.length; i += 1) {
    const ch = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return input.slice(open, i + 1);
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * `captions.playerCaptionsTracklistRenderer.captionTracks[]`, each entry carrying
 * `baseUrl`, `languageCode`, an optional `kind: "asr"` and a `name` that is either
 * `{simpleText}` or `{runs:[{text}]}` depending on the day. Anything missing or
 * reshaped yields an empty list, which the caller reports as "no captions".
 */
export function captionTracksFrom(playerResponse: unknown): CaptionTrack[] {
  const captions = asRecord(asRecord(playerResponse)?.captions);
  const renderer = asRecord(
    captions?.playerCaptionsTracklistRenderer ?? captions?.playerCaptionsRenderer,
  );
  const raw = renderer?.captionTracks;
  if (!Array.isArray(raw)) return [];
  const out: CaptionTrack[] = [];
  for (const item of raw) {
    const rec = asRecord(item);
    const baseUrl = text(rec?.baseUrl);
    if (!baseUrl) continue;
    const name = asRecord(rec?.name);
    const runs = name?.runs;
    const label =
      text(name?.simpleText) ??
      (Array.isArray(runs) ? text(asRecord(runs[0])?.text) : undefined);
    out.push({
      baseUrl,
      languageCode: text(rec?.languageCode) ?? "",
      ...(text(rec?.kind) === undefined ? {} : { kind: text(rec?.kind) as string }),
      ...(label === undefined ? {} : { name: label }),
    });
  }
  return out;
}

/**
 * Picks a track: a human-authored English one first, then any human-authored one,
 * then auto-generated English, then whatever is left.
 *
 * WHY prefer human over `kind: "asr"`: auto-captions have no punctuation and no
 * speaker turns, which measurably degrades the digest. WHY prefer English at all:
 * the digest prompt writes in the language of its input, and picking the original
 * language would be better — but the player response does not reliably say which
 * that is, and a preference beats an arbitrary array order.
 */
export function pickCaptionTrack(tracks: readonly CaptionTrack[]): CaptionTrack | null {
  const isEnglish = (t: CaptionTrack) => t.languageCode.toLowerCase().startsWith("en");
  const isManual = (t: CaptionTrack) => t.kind !== "asr";
  return (
    tracks.find((t) => isManual(t) && isEnglish(t)) ??
    tracks.find(isManual) ??
    tracks.find(isEnglish) ??
    tracks[0] ??
    null
  );
}

/**
 * The URL to actually fetch: the track's own `baseUrl` with `fmt=json3` requested.
 *
 * Returns null when the URL is unparseable, is not on a YouTube host, or fails the
 * SSRF check — `baseUrl` comes out of page JSON, so it is attacker-influenced input
 * and gets the same scrutiny as a URL the owner typed.
 */
export function captionRequestUrl(baseUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(decodeEntities(baseUrl));
  } catch {
    return null;
  }
  if (!isYoutubeHost(parsed.hostname)) return null;
  try {
    assertSafeUrl(parsed.toString());
  } catch {
    return null;
  }
  // json3 is the pleasant format; the parser below also reads the XML ones, so if
  // this param stops being honoured the transcript still comes through.
  parsed.searchParams.set("fmt", "json3");
  return parsed.toString();
}

/** `{"events":[{"segs":[{"utf8":"..."}]}]}` — the fmt=json3 shape. */
function fromJson3(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const events = asRecord(parsed)?.events;
  if (!Array.isArray(events)) return null;
  // Segments *within* one cue are concatenated: json3 splits a cue per word and
  // each segment carries its own leading space, so a separator here would double
  // them. Separate cues are joined with a space, because the first segment of a cue
  // does not carry one — the format expects a line break between cues.
  const cues: string[] = [];
  for (const event of events) {
    const segs = asRecord(event)?.segs;
    if (!Array.isArray(segs)) continue;
    let cue = "";
    for (const seg of segs) {
      const utf8 = asRecord(seg)?.utf8;
      if (typeof utf8 === "string") cue += utf8;
    }
    if (cue.trim().length > 0) cues.push(cue);
  }
  return cues.length === 0 ? null : cues.join(" ");
}

/** `<transcript><text start="0" dur="1">...</text></transcript>` — every XML fmt. */
function fromXml(body: string): string | null {
  const parts: string[] = [];
  const re = /<(?:text|p)\b[^>]*>([\s\S]*?)<\/(?:text|p)>/gi;
  for (;;) {
    const match = re.exec(body);
    if (match === null) break;
    const inner = match[1];
    if (inner === undefined) continue;
    // The XML payload is entity-encoded twice: `&amp;#39;` for an apostrophe. One
    // pass leaves `&#39;` on screen, so decode until it stops changing (bounded).
    let value = inner.replace(/<[^>]*>/g, "");
    for (let i = 0; i < 3; i += 1) {
      const next = decodeEntities(value);
      if (next === value) break;
      value = next;
    }
    if (value.trim().length > 0) parts.push(value);
  }
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * Caption payload to plain prose, accepting json3 or any of the XML formats — the
 * point of sniffing rather than trusting `fmt` is that a changed or ignored param
 * then costs nothing.
 *
 * Timings are dropped on purpose: the digest wants the argument, not a subtitle
 * file, and timestamps in the prompt only spend tokens.
 */
export function transcriptToText(body: string): string | null {
  const raw = fromJson3(body) ?? fromXml(body);
  if (raw === null) return null;
  const cleaned = raw
    // Caption cues carry hard newlines mid-sentence and [Music]-style annotations.
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length === 0 ? null : cleaned;
}

/**
 * `playabilityStatus`, when it says something other than OK. This is what tells a
 * blocked request apart from a video that genuinely has no subtitles — the two are
 * otherwise identical (HTTP 200, valid JSON, no `captions` key), and conflating
 * them would make the dominant failure mode invisible.
 */
export function playabilityProblem(playerResponse: unknown): string | null {
  const status = asRecord(asRecord(playerResponse)?.playabilityStatus);
  const code = text(status?.status);
  if (code === undefined || code === "OK") return null;
  const reason =
    text(status?.reason) ??
    text(
      asRecord(
        asRecord(asRecord(status?.errorScreen)?.playerErrorMessageRenderer)?.reason,
      )?.simpleText,
    );
  // Trimmed: this string is YouTube's, it ends up in a DB column and on screen.
  const detail = reason === undefined ? code : `${code}: ${reason}`;
  return detail.slice(0, 200);
}

/**
 * Whether a caption URL is proof-of-origin gated. `exp=xpe` is the marker; fetching
 * one without a `pot` token returns an empty 200 body, so the only useful thing to
 * do with it is say so.
 */
export function needsProofOfOrigin(baseUrl: string): boolean {
  return /[?&]exp=xpe(&|$)/.test(baseUrl);
}

/** The video's title: the player response first, the page `<title>` as the fallback. */
export function videoTitleFrom(
  html: string,
  playerResponse: unknown,
): string | undefined {
  const details = asRecord(asRecord(playerResponse)?.videoDetails);
  const fromDetails = text(details?.title);
  if (fromDetails !== undefined) return fromDetails.trim();
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return undefined;
  const decoded = decodeEntities(match[1]).replace(/\s+/g, " ").trim();
  const stripped = decoded.replace(/\s*-\s*YouTube$/i, "").trim();
  return stripped.length > 0 ? stripped : undefined;
}

/* ------------------------------------------------------------------ fetching */

async function get(
  url: string,
  fetchImpl: typeof fetch,
  accept: string,
): Promise<Response> {
  return fetchImpl(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent": BROWSER_UA,
      accept,
      // Nudges the watch page towards English captions, and towards serving the
      // player response rather than a language picker.
      "accept-language": "en-US,en;q=0.9",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

/**
 * Fetches a video's transcript. Throws `ExtractionError` carrying
 * `TRANSCRIPT_UNAVAILABLE` for every reachable failure — including a fetch that
 * rejects, so a network error or an abort surfaces as the same readable sentence
 * rather than as a raw `TypeError` from the runtime.
 */
export async function fetchYoutubeTranscript(
  videoId: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<YoutubeTranscript> {
  // `has_verified=1` is the surviving half of the old age-gate bypass pair;
  // `bpctr` was verified dead on 2026-08-12 and is deliberately not sent. The GDPR
  // consent interstitial is a *cookie*, not a param, and a Worker's fetch has no
  // cookie jar — so hitting that wall is a reported failure, not something to work
  // around here.
  const watchUrl = `${youtubeWatchUrl(videoId)}&has_verified=1`;
  assertSafeUrl(watchUrl);

  let html: string;
  try {
    const response = await get(watchUrl, fetchImpl, "text/html,*/*;q=0.8");
    if (!response.ok) {
      throw transcriptUnavailable(
        `watch page returned HTTP ${response.status}`,
      );
    }
    html = await readCappedText(response, WATCH_PAGE_MAX_BYTES);
  } catch (err) {
    throw wrap(err, "could not load the watch page");
  }

  const playerResponse = extractPlayerResponse(html);
  if (playerResponse === null) {
    // Overwhelmingly the consent/bot wall: a datacenter IP asking for a watch page
    // gets a cookie notice with no player response in it.
    throw transcriptUnavailable(
      "the watch page carried no player data — YouTube may be showing a consent or bot check instead",
    );
  }

  const tracks = captionTracksFrom(playerResponse);
  const track = pickCaptionTrack(tracks);
  if (track === null) {
    // Prefer YouTube's own explanation when it gave one: a bot-blocked request and
    // a video with no subtitles look identical from the captions key alone, and
    // reporting the former as the latter hides the thing that is actually wrong.
    const problem = playabilityProblem(playerResponse);
    throw transcriptUnavailable(
      problem === null
        ? "this video has no caption track"
        : `YouTube refused to play it — ${problem}`,
    );
  }

  if (needsProofOfOrigin(track.baseUrl)) {
    // Fetching an `exp=xpe` URL returns an empty 200; there is nothing to gain from
    // spending the request, and a specific reason beats "came back empty".
    throw transcriptUnavailable(
      "the caption url requires a proof-of-origin token that only YouTube's own player can mint",
    );
  }

  const requestUrl = captionRequestUrl(track.baseUrl);
  if (requestUrl === null) {
    throw transcriptUnavailable("the caption url was not a usable YouTube url");
  }

  let body: string;
  try {
    const response = await get(requestUrl, fetchImpl, "application/json,text/xml,*/*;q=0.8");
    if (!response.ok) {
      throw transcriptUnavailable(
        `the caption track returned HTTP ${response.status}`,
      );
    }
    body = await readCappedText(response, TRANSCRIPT_MAX_BYTES);
  } catch (err) {
    throw wrap(err, "could not load the caption track");
  }

  const transcript = transcriptToText(body);
  if (transcript === null) {
    // A 200 with an empty body is the documented-by-folklore answer for a track
    // that exists in the list but has no cues, and for a token-gated request.
    throw transcriptUnavailable("the caption track came back empty");
  }
  if (transcript.length < MIN_TRANSCRIPT_CHARS) {
    throw transcriptUnavailable(
      `the transcript was too short (${transcript.length} chars) to summarize`,
    );
  }

  const title = videoTitleFrom(html, playerResponse);
  return {
    text: transcript,
    ...(title === undefined ? {} : { title }),
    track,
  };
}

/**
 * Keeps an already-readable failure as it is and turns anything else — an aborted
 * fetch, a DNS error, a runtime TypeError — into the same sentence with a cause.
 */
function wrap(err: unknown, what: string): ExtractionError {
  if (err instanceof ExtractionError && err.message.startsWith(TRANSCRIPT_UNAVAILABLE)) {
    return err;
  }
  const detail = err instanceof Error ? err.message : String(err);
  return transcriptUnavailable(`${what}: ${detail}`);
}
