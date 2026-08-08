import {
  CHAT_SEARCH_DEFAULT_TOP_K,
  CHAT_SEARCH_MAX_TOP_K,
  CHAT_STATS_KINDS,
  CHAT_TOOL_DESCRIPTIONS,
  CHAT_TOOL_SCHEMAS,
} from "@til/core";
import type { ChatTool } from "@til/core";
import { z } from "zod";
import type { Deps } from "./deps.js";
import {
  getEntryForTool,
  searchEntries,
  stats,
  type EntryForTool,
  type SearchResultItem,
  type StatsRow,
} from "./retrieval.js";

/** Longest window the model may ask for; ~5 years covers "all time". */
export const CHAT_MAX_SINCE_DAYS = 1826;
/** Result caps: tool output is context the user pays for on every later step. */
export const CHAT_MAX_TITLE_CHARS = 200;
export const CHAT_MAX_TAKEAWAY_CHARS = 400;
export const CHAT_MAX_SUMMARY_CHARS = 1200;
export const CHAT_MAX_QUESTION_CHARS = 400;
export const CHAT_MAX_TAGS = 8;
export const CHAT_MAX_STATS_ROWS = 52;

// WHY clamp instead of reject: a model that asks for topK=999 should get 20 back
// and keep going, not burn a step on a validation error it cannot read.
const searchArgs = z.object({
  query: z.string().min(1).max(500),
  topK: z.coerce
    .number()
    .transform((n) => Math.trunc(n))
    .transform((n) => Math.min(CHAT_SEARCH_MAX_TOP_K, Math.max(1, n)))
    .catch(CHAT_SEARCH_DEFAULT_TOP_K)
    .default(CHAT_SEARCH_DEFAULT_TOP_K),
  tag: z.string().max(80).optional().catch(undefined),
  sinceDays: z.coerce
    .number()
    .transform((n) => Math.trunc(n))
    .transform((n) => Math.min(CHAT_MAX_SINCE_DAYS, Math.max(1, n)))
    .optional()
    .catch(undefined),
});

const entryArgs = z.object({
  id: z.string().min(1).max(200),
});

// `kind` is the one argument that cannot be repaired: guessing an aggregate the
// user did not ask for is worse than telling the model it chose a bad value.
const statsArgs = z.object({
  kind: z.enum(CHAT_STATS_KINDS),
  sinceDays: z.coerce
    .number()
    .transform((n) => Math.trunc(n))
    .transform((n) => Math.min(CHAT_MAX_SINCE_DAYS, Math.max(1, n)))
    .optional()
    .catch(undefined),
});

export type ChatSearchArgs = z.output<typeof searchArgs>;
export type ChatStatsArgs = z.output<typeof statsArgs>;

export function parseSearchArgs(raw: unknown): ChatSearchArgs {
  return searchArgs.parse(raw);
}

export function parseStatsArgs(raw: unknown): ChatStatsArgs {
  return statsArgs.parse(raw);
}

export function capSearchItem(item: SearchResultItem): SearchResultItem {
  return {
    id: item.id,
    title: truncate(item.title, CHAT_MAX_TITLE_CHARS),
    url: item.url,
    sourceDomain: item.sourceDomain,
    takeaway: truncate(item.takeaway, CHAT_MAX_TAKEAWAY_CHARS),
    tags: item.tags.slice(0, CHAT_MAX_TAGS),
    createdAt: item.createdAt,
    score: item.score,
  };
}

export function capEntry(entry: EntryForTool): EntryForTool {
  return {
    id: entry.id,
    title: truncate(entry.title, CHAT_MAX_TITLE_CHARS),
    url: entry.url,
    summary: truncate(entry.summary, CHAT_MAX_SUMMARY_CHARS),
    takeaway: truncate(entry.takeaway, CHAT_MAX_TAKEAWAY_CHARS),
    question: truncate(entry.question, CHAT_MAX_QUESTION_CHARS),
    tags: entry.tags.slice(0, CHAT_MAX_TAGS),
    createdAt: entry.createdAt,
  };
}

export function capStatsRows(rows: StatsRow[]): StatsRow[] {
  return rows.slice(0, CHAT_MAX_STATS_ROWS);
}

/**
 * Binds the three read-only retrieval functions as chat tools: zod validates and
 * clamps what the model asked for, and every result is capped before it goes
 * back into the transcript.
 */
export function buildChatTools(deps: Deps): ChatTool[] {
  return [
    {
      name: "search_entries",
      description: CHAT_TOOL_DESCRIPTIONS.search_entries,
      inputSchema: CHAT_TOOL_SCHEMAS.search_entries,
      execute: async (raw) => {
        const args = parseSearchArgs(raw);
        const { items } = await searchEntries(deps, args);
        return { items: items.map(capSearchItem) };
      },
    },
    {
      name: "get_entry",
      description: CHAT_TOOL_DESCRIPTIONS.get_entry,
      inputSchema: CHAT_TOOL_SCHEMAS.get_entry,
      execute: async (raw) => {
        const args = entryArgs.parse(raw);
        const entry = await getEntryForTool(deps, args);
        if (!entry) return { entry: null };
        return { entry: capEntry(entry) };
      },
    },
    {
      name: "stats",
      description: CHAT_TOOL_DESCRIPTIONS.stats,
      inputSchema: CHAT_TOOL_SCHEMAS.stats,
      execute: async (raw) => {
        const args = parseStatsArgs(raw);
        const result = await stats(deps, args);
        return { kind: result.kind, rows: capStatsRows(result.rows) };
      },
    },
  ];
}

function truncate(value: string | null, max: number): string | null {
  if (value === null) return null;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}
