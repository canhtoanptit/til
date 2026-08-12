import type {
  DigestItem,
  DigestRun,
  Entry,
  Feed,
  Feedback,
  Review,
} from "@til/db";
import {
  isDigestKind,
  isReviewCardState,
  isReviewGrade,
  normalizeContentType,
} from "@til/core";
import type {
  ContentType,
  DigestKind,
  ReviewCardState,
  ReviewGrade,
} from "@til/core";

export type EntryStatus = "pending" | "ready" | "failed";

export type DigestStatus = "pending" | "ready" | "failed";

export interface EntryDTO {
  id: string;
  url: string;
  canonicalUrl: string;
  title: string | null;
  sourceDomain: string | null;
  summary: string | null;
  takeaway: string | null;
  question: string | null;
  tags: string[];
  /** What kind of thing this points at (P25). Additive: every response that carried
   * an entry before this existed now also says "article", which is what it was. */
  contentType: ContentType;
  /** Owner-set (P23). Additive: every response that carried an entry before this
   * existed now also says "not favorited, not archived, no note". */
  favorite: boolean;
  archived: boolean;
  note: string | null;
  status: EntryStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntryDetailDTO extends EntryDTO {
  contentMarkdown: string | null;
}

/** One row of `GET /api/tags`. `count` deliberately excludes archived entries —
 * see `tagCountRows` in routes/tags.ts for why. */
export interface TagCountDTO {
  tag: string;
  count: number;
}

export type FeedbackKind = "up" | "down";

/** One row of the append-only feedback log, exactly as it was stored. */
export interface FeedbackDTO {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  entryId: string | null;
  kind: FeedbackKind;
  comment: string | null;
  createdAt: number;
}

/** The column has no CHECK constraint, so a value that is neither 'up' nor
 * 'down' can only come from a hand-written row; read it as the safer 'down'
 * rather than inventing a positive signal. */
export function normalizeFeedbackKind(raw: string): FeedbackKind {
  return raw === "up" ? "up" : "down";
}

export function toFeedbackDTO(row: Feedback): FeedbackDTO {
  return {
    id: row.id,
    conversationId: row.conversationId ?? null,
    messageId: row.messageId ?? null,
    entryId: row.entryId ?? null,
    kind: normalizeFeedbackKind(row.kind),
    comment: row.comment ?? null,
    createdAt: row.createdAt,
  };
}

export interface RelatedEntryDTO {
  id: string;
  title: string | null;
  sourceDomain: string | null;
  takeaway: string | null;
  score: number;
}

/** See `RelatedResult` in retrieval.ts for what `available: false` means. */
export interface RelatedEntriesDTO {
  available: boolean;
  items: RelatedEntryDTO[];
}

export interface DigestEvidenceDTO {
  url: string;
  sourceName: string;
  title: string;
}

export interface DigestItemDTO {
  rank: number;
  title: string;
  url: string;
  sourceName: string;
  sourceDomain: string;
  /** The base topical score. Personalization is reported separately, below. */
  score: number;
  /**
   * How close this item sits to the owner's recent saved reading, 0..1, or null
   * when personalization did not run for the item (C18). Additive and nullable, so
   * every digest stored before this existed reads back as "not personalized".
   */
  interestScore: number | null;
  why: string | null;
  evidence: DigestEvidenceDTO[];
}

export interface DigestSummaryDTO {
  id: string;
  runAt: number;
  windowDays: number;
  /** 'weekly' | 'monthly-report'. Rows written before 0011 read as 'weekly'. */
  kind: DigestKind;
  status: DigestStatus;
  title: string | null;
  intro: string | null;
  itemCount: number;
  error: string | null;
}

export interface DigestDetailDTO extends DigestSummaryDTO {
  items: DigestItemDTO[];
}

export interface FeedDTO {
  id: string;
  url: string;
  title: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** Single definition of how the JSON `tags` column is read — retrieval and the
 * stats aggregates share it so a count can never drift from a response. */
export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const t of parsed) if (typeof t === "string") out.push(t);
    return out;
  } catch {
    return [];
  }
}

function normalizeStatus(raw: string): EntryStatus {
  if (raw === "ready" || raw === "failed") return raw;
  return "pending";
}

export function toEntryDTO(row: Entry): EntryDTO {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonicalUrl,
    title: row.title ?? null,
    sourceDomain: row.sourceDomain ?? null,
    summary: row.summary ?? null,
    takeaway: row.takeaway ?? null,
    question: row.question ?? null,
    tags: parseTags(row.tags),
    contentType: normalizeContentType(row.contentType),
    favorite: row.favorite,
    archived: row.archived,
    note: row.note ?? null,
    status: normalizeStatus(row.status),
    error: row.error ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toEntryDetailDTO(row: Entry): EntryDetailDTO {
  return {
    ...toEntryDTO(row),
    contentMarkdown: row.contentMarkdown ?? null,
  };
}

export function toRelatedEntryDTO(row: Entry, score: number): RelatedEntryDTO {
  return {
    id: row.id,
    title: row.title ?? null,
    sourceDomain: row.sourceDomain ?? null,
    takeaway: row.takeaway ?? null,
    score,
  };
}

export function toFeedDTO(row: Feed): FeedDTO {
  return {
    id: row.id,
    url: row.url,
    title: row.title ?? null,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * The question side of a review card. It deliberately carries no `takeaway`,
 * `summary`, `tags` or `contentMarkdown`: the reveal is fetched from
 * `GET /api/entries/:id` only once the user has asked for it, so no answer can
 * ever ride along in the queue payload and get rendered early by accident.
 */
export interface ReviewQueueItemDTO {
  entryId: string;
  title: string | null;
  question: string | null;
  url: string;
  sourceDomain: string | null;
  state: ReviewCardState;
  dueAt: number | null;
  intervalDays: number | null;
  ease: number;
  lapses: number;
}

export interface ReviewQueueDTO {
  items: ReviewQueueItemDTO[];
  /** Every card due at request time, not just the ones inside `limit`. */
  dueCount: number;
}

export interface ReviewScheduleDTO {
  entryId: string;
  state: ReviewCardState;
  dueAt: number | null;
  intervalDays: number | null;
  ease: number;
  lapses: number;
  lastGrade: ReviewGrade | null;
  reviewedAt: number | null;
}

export interface ReviewEnrollDTO {
  enrolled: number;
  skipped: number;
}

export function normalizeReviewState(raw: string): ReviewCardState {
  return isReviewCardState(raw) ? raw : "new";
}

/** Row shape of the queue join — question-side entry columns only. */
export interface ReviewQueueRow {
  entryId: string;
  state: string;
  dueAt: number | null;
  intervalDays: number | null;
  ease: number;
  lapses: number;
  title: string | null;
  question: string | null;
  url: string;
  sourceDomain: string | null;
}

export function toReviewQueueItemDTO(row: ReviewQueueRow): ReviewQueueItemDTO {
  return {
    entryId: row.entryId,
    title: row.title ?? null,
    question: row.question ?? null,
    url: row.url,
    sourceDomain: row.sourceDomain ?? null,
    state: normalizeReviewState(row.state),
    dueAt: row.dueAt ?? null,
    intervalDays: row.intervalDays ?? null,
    ease: row.ease,
    lapses: row.lapses,
  };
}

export function toReviewScheduleDTO(row: Review): ReviewScheduleDTO {
  return {
    entryId: row.entryId,
    state: normalizeReviewState(row.state),
    dueAt: row.dueAt ?? null,
    intervalDays: row.intervalDays ?? null,
    ease: row.ease,
    lapses: row.lapses,
    lastGrade: isReviewGrade(row.lastGrade) ? row.lastGrade : null,
    reviewedAt: row.reviewedAt ?? null,
  };
}

export function parseEvidence(
  raw: string | null | undefined,
): DigestEvidenceDTO[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: DigestEvidenceDTO[] = [];
  for (const hit of parsed) {
    if (typeof hit !== "object" || hit === null) continue;
    const { url, sourceName, title } = hit as Record<string, unknown>;
    if (typeof url !== "string" || typeof sourceName !== "string") continue;
    out.push({
      url,
      sourceName,
      title: typeof title === "string" ? title : "",
    });
  }
  return out;
}

export function toDigestSummaryDTO(
  row: DigestRun,
  itemCount: number,
): DigestSummaryDTO {
  return {
    id: row.id,
    runAt: row.runAt,
    windowDays: row.windowDays,
    // The column is `text`, so an unexpected value is possible in principle;
    // 'weekly' is the safe reading, and it is what the column default says too.
    kind: isDigestKind(row.kind) ? row.kind : "weekly",
    status: normalizeStatus(row.status),
    title: row.title ?? null,
    intro: row.intro ?? null,
    itemCount,
    error: row.error ?? null,
  };
}

export function toDigestItemDTO(row: DigestItem): DigestItemDTO {
  return {
    rank: row.rank,
    title: row.title,
    url: row.url,
    sourceName: row.sourceName,
    sourceDomain: row.sourceDomain,
    score: row.score,
    interestScore: row.interestScore ?? null,
    why: row.why ?? null,
    evidence: parseEvidence(row.evidence),
  };
}

export function toDigestDetailDTO(
  row: DigestRun,
  items: readonly DigestItem[],
): DigestDetailDTO {
  return {
    ...toDigestSummaryDTO(row, items.length),
    items: items.map(toDigestItemDTO),
  };
}
