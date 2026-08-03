import type { Entry } from "@til/db";

export type EntryStatus = "pending" | "ready" | "failed";

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

function parseTags(raw: string | null | undefined): string[] {
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
