import { getToolPartState } from "@cloudflare/ai-chat/react";
import type { ChatConversationDTO } from "../api";

/** One entry of `UIMessage["parts"]`, borrowed from the SDK's own accessors so
 * the client never has to import `ai` (not a declared dependency here). */
export type ChatUIPart = Parameters<typeof getToolPartState>[0];
export type ChatToolState = ReturnType<typeof getToolPartState>;

export type ChatToolName = "search_entries" | "get_entry" | "stats";

const TOOL_PART_TYPES: Record<string, ChatToolName> = {
  "tool-search_entries": "search_entries",
  "tool-get_entry": "get_entry",
  "tool-stats": "stats",
};

const STATS_LABELS: Record<string, string> = {
  totals: "your totals",
  per_week: "entries per week",
  top_tags: "top tags",
  top_domains: "top domains",
  streak: "your saving streak",
};

const TOOL_ICONS: Record<ChatToolName, string> = {
  search_entries: "🔍",
  get_entry: "📄",
  stats: "📊",
};

/** `null` for text, reasoning, step markers and any tool we do not render. */
export function toolNameOfPart(part: ChatUIPart): ChatToolName | null {
  return TOOL_PART_TYPES[part.type] ?? null;
}

export function toolIcon(tool: ChatToolName): string {
  return TOOL_ICONS[tool];
}

export function isToolPending(state: ChatToolState): boolean {
  return state === "loading" || state === "streaming";
}

export interface ChatSearchHit {
  id: string;
  title: string | null;
  url: string;
  sourceDomain: string | null;
  takeaway: string | null;
  tags: string[];
  createdAt: number;
}

export interface ChatEntryResult {
  id: string;
  title: string | null;
  url: string;
  summary: string | null;
  takeaway: string | null;
  question: string | null;
  tags: string[];
  createdAt: number;
}

export interface ChatStatsResult {
  kind: string | null;
  columns: string[];
  rows: Record<string, string | number>[];
}

export interface ChatSearchInput {
  query: string | null;
  tag: string | null;
  sinceDays: number | null;
  topK: number | null;
}

export function parseSearchInput(input: unknown): ChatSearchInput {
  return {
    query: readString(readProp(input, "query")),
    tag: readString(readProp(input, "tag")),
    sinceDays: readNumber(readProp(input, "sinceDays")),
    topK: readNumber(readProp(input, "topK")),
  };
}

export function parseEntryInput(input: unknown): { id: string | null } {
  return { id: readString(readProp(input, "id")) };
}

export function parseStatsInput(input: unknown): {
  kind: string | null;
  sinceDays: number | null;
} {
  return {
    kind: readString(readProp(input, "kind")),
    sinceDays: readNumber(readProp(input, "sinceDays")),
  };
}

export function parseSearchHits(output: unknown): ChatSearchHit[] {
  const hits: ChatSearchHit[] = [];
  for (const raw of readArray(readProp(output, "items"))) {
    const id = readString(readProp(raw, "id"));
    const url = readString(readProp(raw, "url"));
    if (id === null || url === null) continue;
    hits.push({
      id,
      url,
      title: readString(readProp(raw, "title")),
      sourceDomain: readString(readProp(raw, "sourceDomain")),
      takeaway: readString(readProp(raw, "takeaway")),
      tags: readStringArray(readProp(raw, "tags")),
      createdAt: readNumber(readProp(raw, "createdAt")) ?? 0,
    });
  }
  return hits;
}

/** The tool answers `{ entry: … | null }`; a miss is a legitimate answer. */
export function parseEntryResult(output: unknown): ChatEntryResult | null {
  const raw = readProp(output, "entry");
  const id = readString(readProp(raw, "id"));
  const url = readString(readProp(raw, "url"));
  if (id === null || url === null) return null;
  return {
    id,
    url,
    title: readString(readProp(raw, "title")),
    summary: readString(readProp(raw, "summary")),
    takeaway: readString(readProp(raw, "takeaway")),
    question: readString(readProp(raw, "question")),
    tags: readStringArray(readProp(raw, "tags")),
    createdAt: readNumber(readProp(raw, "createdAt")) ?? 0,
  };
}

export function parseStatsResult(output: unknown): ChatStatsResult {
  const rows: Record<string, string | number>[] = [];
  const columns: string[] = [];
  for (const raw of readArray(readProp(output, "rows"))) {
    if (typeof raw !== "object" || raw === null) continue;
    const row: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      row[key] = value;
      if (!columns.includes(key)) columns.push(key);
    }
    if (Object.keys(row).length > 0) rows.push(row);
  }
  return { kind: readString(readProp(output, "kind")), columns, rows };
}

export function statsLabel(kind: string | null): string {
  if (kind === null) return "your reading stats";
  return STATS_LABELS[kind] ?? kind.replace(/_/g, " ");
}

/** The one line shown while a tool part is collapsed. */
export function toolSummary(
  tool: ChatToolName,
  input: unknown,
  output: unknown,
  state: ChatToolState,
): string {
  const done = state === "complete";
  switch (tool) {
    case "search_entries": {
      const args = parseSearchInput(input);
      const what = args.query === null ? "your entries" : `“${args.query}”`;
      const filters = searchFilterSuffix(args);
      const head = `Searched your entries for ${what}${filters}`;
      if (!done) return head;
      return `${head} — ${formatResultCount(parseSearchHits(output).length)}`;
    }
    case "get_entry": {
      if (!done) return "Opened one of your entries";
      const entry = parseEntryResult(output);
      if (entry === null) return "Looked for an entry that no longer exists";
      const title = entry.title?.trim();
      return title ? `Opened “${title}”` : `Opened ${entry.url}`;
    }
    case "stats": {
      const kind = readString(readProp(output, "kind")) ?? readString(readProp(input, "kind"));
      const since = readNumber(readProp(input, "sinceDays"));
      const window = since === null ? "" : ` (last ${since} days)`;
      return `Looked up ${statsLabel(kind)}${window}`;
    }
  }
}

/** `errorText` has no public accessor in the SDK, so it is read defensively. */
export function toolErrorText(part: ChatUIPart): string | null {
  return readString(readProp(part, "errorText"));
}

export function toolStateLabel(state: ChatToolState): string | null {
  switch (state) {
    case "loading":
      return "deciding what to look up…";
    case "streaming":
      return "looking…";
    case "error":
      return "this lookup failed";
    case "denied":
      return "this lookup was declined";
    default:
      return null;
  }
}

export function chatConversationTitle(chat: ChatConversationDTO): string {
  return chat.title?.trim() || "Untitled conversation";
}

export function formatMessageCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "no messages";
  return n === 1 ? "1 message" : `${n} messages`;
}

export function formatResultCount(n: number): string {
  if (n === 0) return "no results";
  return n === 1 ? "1 result" : `${n} results`;
}

export function formatChatDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

export function formatShortDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Coarse and deliberately absolute past ~a week: "3 weeks ago" helps nobody. */
export function formatRelative(ms: number, now: number = Date.now()): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const delta = now - ms;
  if (delta < MINUTE_MS) return "just now";
  if (delta < HOUR_MS) {
    const mins = Math.floor(delta / MINUTE_MS);
    return mins === 1 ? "1 minute ago" : `${mins} minutes ago`;
  }
  if (delta < DAY_MS) {
    const hours = Math.floor(delta / HOUR_MS);
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }
  if (delta < 7 * DAY_MS) {
    const days = Math.floor(delta / DAY_MS);
    return days === 1 ? "yesterday" : `${days} days ago`;
  }
  return formatShortDate(ms);
}

export function statsColumnLabel(column: string): string {
  return column.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
}

function searchFilterSuffix(args: ChatSearchInput): string {
  const parts: string[] = [];
  if (args.tag !== null) parts.push(`tag ${args.tag}`);
  if (args.sinceDays !== null) parts.push(`last ${args.sinceDays} days`);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}

// Tool inputs and outputs cross the wire as `unknown`; these readers are the
// only place that shape is asserted, so a malformed frame degrades to a blank
// field instead of a thrown render.
function readProp(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): string[] {
  return readArray(value).filter((v): v is string => typeof v === "string");
}
