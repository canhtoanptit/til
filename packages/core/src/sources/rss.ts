import { SourceError } from "../errors.js";
import type {
  Candidate,
  FetchCandidatesOptions,
  SourceAdapter,
} from "../types.js";
import { assertSafeUrl } from "../url.js";
import {
  cleanSnippet,
  defaultNow,
  describeError,
  fetchSourceText,
  isSafeCandidateUrl,
  isWithinWindow,
  parseTimestamp,
} from "./http.js";
import {
  asArray,
  atomLinkHref,
  child,
  childText,
  firstChildText,
  parseFeedXml,
} from "./xml.js";

const SOURCE_NAME = "rss";

const DATE_KEYS = ["pubDate", "published", "updated", "date"] as const;
const SNIPPET_KEYS = ["description", "summary", "encoded", "content"] as const;

export interface RssAdapterOptions {
  feeds: readonly string[];
  now?: () => number;
  onFeedError?: (feedUrl: string, error: unknown) => void;
}

export class RssAdapter implements SourceAdapter {
  readonly name = SOURCE_NAME;
  private readonly feeds: readonly string[];
  private readonly now: () => number;
  private readonly onFeedError:
    | ((feedUrl: string, error: unknown) => void)
    | undefined;

  constructor(opts: RssAdapterOptions) {
    this.feeds = [...opts.feeds];
    this.now = opts.now ?? defaultNow;
    this.onFeedError = opts.onFeedError;
  }

  async fetchCandidates(opts: FetchCandidatesOptions): Promise<Candidate[]> {
    if (this.feeds.length === 0) return [];
    const now = this.now();

    const settled = await Promise.allSettled(
      this.feeds.map((feedUrl) => this.fetchFeed(feedUrl, opts, now)),
    );

    const candidates: Candidate[] = [];
    const failures: string[] = [];
    settled.forEach((result, index) => {
      const feedUrl = this.feeds[index] ?? "(unknown feed)";
      if (result.status === "fulfilled") {
        candidates.push(...result.value);
        return;
      }
      failures.push(`${feedUrl}: ${describeError(result.reason)}`);
      this.onFeedError?.(feedUrl, result.reason);
    });

    // One dead feed must not sink the digest; only a total wipeout is an error.
    if (failures.length === this.feeds.length) {
      throw new SourceError(
        SOURCE_NAME,
        `${SOURCE_NAME}: all ${this.feeds.length} feed(s) failed — ${failures.join("; ")}`,
      );
    }

    candidates.sort(
      (a, b) =>
        b.publishedAt - a.publishedAt ||
        (a.url < b.url ? -1 : a.url > b.url ? 1 : 0),
    );
    return candidates.slice(0, opts.limit);
  }

  private async fetchFeed(
    feedUrl: string,
    opts: FetchCandidatesOptions,
    now: number,
  ): Promise<Candidate[]> {
    assertSafeUrl(feedUrl);
    const sourceName = feedSourceName(feedUrl);
    const xml = await fetchSourceText(feedUrl, {
      source: sourceName,
      fetchImpl: opts.fetchImpl,
    });
    const items = feedItems(parseFeedXml(xml, sourceName), sourceName);

    const candidates: Candidate[] = [];
    for (const item of items) {
      const candidate = toCandidate(item, sourceName);
      if (candidate === undefined) continue;
      if (!isWithinWindow(candidate.publishedAt, now, opts.windowDays)) continue;
      candidates.push(candidate);
      if (candidates.length >= opts.limit) break;
    }
    return candidates;
  }
}

export function createRssAdapter(opts: RssAdapterOptions): SourceAdapter {
  return new RssAdapter(opts);
}

export function feedSourceName(feedUrl: string): string {
  return `${SOURCE_NAME}:${new URL(feedUrl).host}`;
}

function feedItems(doc: unknown, sourceName: string): unknown[] {
  const channel = child(child(doc, "rss"), "channel");
  if (channel !== undefined) return asArray(child(channel, "item"));

  const feed = child(doc, "feed");
  if (feed !== undefined) return asArray(child(feed, "entry"));

  throw new SourceError(
    sourceName,
    `${sourceName}: payload was neither an RSS channel nor an Atom feed`,
  );
}

function toCandidate(item: unknown, sourceName: string): Candidate | undefined {
  const title = childText(item, "title");
  if (title === undefined) return undefined;

  const publishedAt = parseTimestamp(firstChildText(item, DATE_KEYS));
  if (publishedAt === undefined) return undefined;

  const url = childText(item, "link") ?? atomLinkHref(item) ?? permalink(item);
  if (url === undefined || !isSafeCandidateUrl(url)) return undefined;

  const candidate: Candidate = { url, title, sourceName, publishedAt };
  const snippet = cleanSnippet(firstChildText(item, SNIPPET_KEYS));
  if (snippet !== undefined) candidate.snippet = snippet;
  return candidate;
}

// RSS 2.0 items may omit <link> and carry the URL in a permalink <guid>.
function permalink(item: unknown): string | undefined {
  const guid = childText(item, "guid");
  if (guid === undefined) return undefined;
  return guid.startsWith("http://") || guid.startsWith("https://")
    ? guid
    : undefined;
}
