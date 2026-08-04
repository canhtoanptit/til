import type { DigestItem, DigestRun, Entry } from "@til/db";

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
  status: EntryStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntryDetailDTO extends EntryDTO {
  contentMarkdown: string | null;
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
  score: number;
  why: string | null;
  evidence: DigestEvidenceDTO[];
}

export interface DigestSummaryDTO {
  id: string;
  runAt: number;
  windowDays: number;
  status: DigestStatus;
  title: string | null;
  intro: string | null;
  itemCount: number;
  error: string | null;
}

export interface DigestDetailDTO extends DigestSummaryDTO {
  items: DigestItemDTO[];
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
