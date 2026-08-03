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
  parseTimestamp,
} from "./http.js";

const SOURCE_NAME = "lobsters";
const BASE = "https://lobste.rs";

export type LobstersFeed = "hottest" | "newest";

export interface LobstersAdapterOptions {
  feed?: LobstersFeed;
  now?: () => number;
}

export class LobstersAdapter implements SourceAdapter {
  readonly name = SOURCE_NAME;
  private readonly feed: LobstersFeed;
  private readonly now: () => number;

  constructor(opts: LobstersAdapterOptions = {}) {
    this.feed = opts.feed ?? "hottest";
    this.now = opts.now ?? defaultNow;
  }

  buildUrl(): string {
    return `${BASE}/${this.feed}.json`;
  }

  async fetchCandidates(opts: FetchCandidatesOptions): Promise<Candidate[]> {
    const now = this.now();
    const url = this.buildUrl();
    const body = await fetchSourceJson(url, {
      source: SOURCE_NAME,
      fetchImpl: opts.fetchImpl,
    });
    const stories = extractStories(body);

    const candidates: Candidate[] = [];
    for (const story of stories) {
      const candidate = toCandidate(story);
      if (candidate === undefined) continue;
      if (!isWithinWindow(candidate.publishedAt, now, opts.windowDays)) continue;
      candidates.push(candidate);
      if (candidates.length >= opts.limit) break;
    }
    return candidates;
  }
}

export function createLobstersAdapter(
  opts?: LobstersAdapterOptions,
): SourceAdapter {
  return new LobstersAdapter(opts);
}

function extractStories(body: unknown): Record<string, unknown>[] {
  if (!Array.isArray(body)) {
    throw new SourceError(
      SOURCE_NAME,
      `${SOURCE_NAME}: response was not an array of stories`,
    );
  }
  const out: Record<string, unknown>[] = [];
  for (const story of body) {
    if (typeof story === "object" && story !== null && !Array.isArray(story)) {
      out.push(story as Record<string, unknown>);
    }
  }
  return out;
}

function toCandidate(story: Record<string, unknown>): Candidate | undefined {
  const title =
    typeof story.title === "string" ? collapseWhitespace(story.title) : "";
  if (title.length === 0) return undefined;

  const publishedAt = parseTimestamp(story.created_at);
  if (publishedAt === undefined) return undefined;

  const storyUrl =
    typeof story.url === "string" && story.url.trim().length > 0
      ? story.url.trim()
      : undefined;
  const commentsUrl =
    typeof story.comments_url === "string" && story.comments_url.length > 0
      ? story.comments_url
      : typeof story.short_id === "string" && story.short_id.length > 0
        ? `${BASE}/s/${story.short_id}`
        : undefined;
  const url = storyUrl ?? commentsUrl;
  if (url === undefined || !isSafeCandidateUrl(url)) return undefined;

  const score =
    typeof story.score === "number" && Number.isFinite(story.score)
      ? story.score
      : undefined;

  const candidate: Candidate = {
    url,
    title,
    sourceName: SOURCE_NAME,
    publishedAt,
  };
  if (score !== undefined) candidate.popularity = score;
  const snippet = cleanSnippet(
    typeof story.description_plain === "string"
      ? story.description_plain
      : story.description,
  );
  if (snippet !== undefined) candidate.snippet = snippet;
  return candidate;
}
