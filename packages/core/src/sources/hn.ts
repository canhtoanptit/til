import { SourceError } from "../errors.js";
import type {
  Candidate,
  FetchCandidatesOptions,
  SourceAdapter,
} from "../types.js";
import {
  cleanSnippet,
  collapseWhitespace,
  defaultNow,
  fetchSourceJson,
  isSafeCandidateUrl,
  isWithinWindow,
  windowStart,
} from "./http.js";

const SOURCE_NAME = "hn";
const ENDPOINT = "https://hn.algolia.com/api/v1/search_by_date";
const DEFAULT_MIN_POINTS = 50;

export interface HNAdapterOptions {
  minPoints?: number;
  now?: () => number;
}

export class HNAdapter implements SourceAdapter {
  readonly name = SOURCE_NAME;
  private readonly minPoints: number;
  private readonly now: () => number;

  constructor(opts: HNAdapterOptions = {}) {
    this.minPoints = opts.minPoints ?? DEFAULT_MIN_POINTS;
    this.now = opts.now ?? defaultNow;
  }

  buildUrl(opts: { windowDays: number; limit: number; now: number }): string {
    const sinceSeconds = Math.floor(
      windowStart(opts.now, opts.windowDays) / 1000,
    );
    const url = new URL(ENDPOINT);
    url.searchParams.set("tags", "story");
    url.searchParams.set(
      "numericFilters",
      `created_at_i>${sinceSeconds},points>${this.minPoints}`,
    );
    url.searchParams.set("hitsPerPage", String(Math.max(1, opts.limit)));
    return url.toString();
  }

  async fetchCandidates(opts: FetchCandidatesOptions): Promise<Candidate[]> {
    const now = this.now();
    const url = this.buildUrl({ ...opts, now });
    const body = await fetchSourceJson(url, {
      source: SOURCE_NAME,
      fetchImpl: opts.fetchImpl,
    });
    const hits = extractHits(body);

    const candidates: Candidate[] = [];
    for (const hit of hits) {
      const candidate = toCandidate(hit);
      if (candidate === undefined) continue;
      if (!isWithinWindow(candidate.publishedAt, now, opts.windowDays)) continue;
      candidates.push(candidate);
      if (candidates.length >= opts.limit) break;
    }
    return candidates;
  }
}

export function createHNAdapter(opts?: HNAdapterOptions): SourceAdapter {
  return new HNAdapter(opts);
}

function extractHits(body: unknown): Record<string, unknown>[] {
  if (typeof body !== "object" || body === null) {
    throw new SourceError(SOURCE_NAME, `${SOURCE_NAME}: response was not an object`);
  }
  const hits = (body as { hits?: unknown }).hits;
  if (!Array.isArray(hits)) {
    throw new SourceError(
      SOURCE_NAME,
      `${SOURCE_NAME}: response had no hits array`,
    );
  }
  const out: Record<string, unknown>[] = [];
  for (const hit of hits) {
    if (typeof hit === "object" && hit !== null && !Array.isArray(hit)) {
      out.push(hit as Record<string, unknown>);
    }
  }
  return out;
}

function toCandidate(hit: Record<string, unknown>): Candidate | undefined {
  const title = typeof hit.title === "string" ? collapseWhitespace(hit.title) : "";
  if (title.length === 0) return undefined;

  const createdAt = hit.created_at_i;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) {
    return undefined;
  }

  const objectId = typeof hit.objectID === "string" ? hit.objectID : undefined;
  const storyUrl = typeof hit.url === "string" && hit.url.length > 0 ? hit.url : undefined;
  const url =
    storyUrl ??
    (objectId === undefined
      ? undefined
      : `https://news.ycombinator.com/item?id=${objectId}`);
  if (url === undefined || !isSafeCandidateUrl(url)) return undefined;

  const points = typeof hit.points === "number" && Number.isFinite(hit.points)
    ? hit.points
    : undefined;

  const candidate: Candidate = {
    url,
    title,
    sourceName: SOURCE_NAME,
    publishedAt: createdAt * 1000,
  };
  if (points !== undefined) candidate.popularity = points;
  const snippet = cleanSnippet(hit.story_text);
  if (snippet !== undefined) candidate.snippet = snippet;
  return candidate;
}
