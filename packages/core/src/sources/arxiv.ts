import { SourceError } from "../errors.js";
import type {
  Candidate,
  FetchCandidatesOptions,
  SourceAdapter,
} from "../types.js";
import {
  cleanSnippet,
  defaultNow,
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

const SOURCE_NAME = "arxiv";
const ENDPOINT = "https://export.arxiv.org/api/query";
const DEFAULT_QUERY = "cat:cs.AI OR cat:cs.LG";

export interface ArxivAdapterOptions {
  query?: string;
  now?: () => number;
}

export class ArxivAdapter implements SourceAdapter {
  readonly name = SOURCE_NAME;
  private readonly query: string;
  private readonly now: () => number;

  constructor(opts: ArxivAdapterOptions = {}) {
    this.query = opts.query ?? DEFAULT_QUERY;
    this.now = opts.now ?? defaultNow;
  }

  buildUrl(opts: { limit: number }): string {
    const url = new URL(ENDPOINT);
    url.searchParams.set("search_query", this.query);
    url.searchParams.set("sortBy", "submittedDate");
    url.searchParams.set("sortOrder", "descending");
    url.searchParams.set("max_results", String(Math.max(1, opts.limit)));
    return url.toString();
  }

  // arXiv asks API clients to stay polite: exactly one request per fetch, no retries.
  async fetchCandidates(opts: FetchCandidatesOptions): Promise<Candidate[]> {
    const now = this.now();
    const url = this.buildUrl({ limit: opts.limit });
    const xml = await fetchSourceText(url, {
      source: SOURCE_NAME,
      fetchImpl: opts.fetchImpl,
    });
    const doc = parseFeedXml(xml, SOURCE_NAME);
    const feed = child(doc, "feed");
    if (feed === undefined) {
      throw new SourceError(
        SOURCE_NAME,
        `${SOURCE_NAME}: response was not an Atom feed`,
      );
    }

    const candidates: Candidate[] = [];
    for (const entry of asArray(child(feed, "entry"))) {
      const candidate = toCandidate(entry);
      if (candidate === undefined) continue;
      if (!isWithinWindow(candidate.publishedAt, now, opts.windowDays)) continue;
      candidates.push(candidate);
      if (candidates.length >= opts.limit) break;
    }
    return candidates;
  }
}

export function createArxivAdapter(opts?: ArxivAdapterOptions): SourceAdapter {
  return new ArxivAdapter(opts);
}

function toCandidate(entry: unknown): Candidate | undefined {
  const title = childText(entry, "title");
  if (title === undefined) return undefined;

  const publishedAt = parseTimestamp(
    firstChildText(entry, ["published", "updated"]),
  );
  if (publishedAt === undefined) return undefined;

  const url = atomLinkHref(entry) ?? childText(entry, "id");
  if (url === undefined || !isSafeCandidateUrl(url)) return undefined;

  const candidate: Candidate = {
    url,
    title,
    sourceName: SOURCE_NAME,
    publishedAt,
  };
  const snippet = cleanSnippet(childText(entry, "summary"));
  if (snippet !== undefined) candidate.snippet = snippet;
  return candidate;
}
