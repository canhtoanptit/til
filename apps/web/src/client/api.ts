import {
  fallbackExportFilename,
  filenameFromDisposition,
  type ExportFormat,
} from "./export-file";

const TOKEN_KEY = "til:token";

export type EntryStatus = "pending" | "ready" | "failed";

/**
 * What kind of thing an entry points at. Restated here rather than imported from
 * `@til/core` for the same reason the DTOs are — the browser bundle stays free of
 * worker and core code, and the server normalizes anything it does not recognise
 * to "article" before it reaches this type.
 */
export type ContentType = "article" | "pdf" | "video";

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
  /** "article" for everything saved before content types existed, and for anything
   * the server does not recognise. */
  contentType: ContentType;
  /** The owner's own marks, as opposed to everything above, which ingest wrote. */
  favorite: boolean;
  archived: boolean;
  /** null, never "" — an emptied note is cleared server-side. */
  note: string | null;
  status: EntryStatus;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface EntryDetailDTO extends EntryDTO {
  contentMarkdown: string | null;
}

/**
 * Which slice of the library to list. "all" is the default view and deliberately
 * excludes archived entries — that is what archiving is for; "favorites" excludes
 * them too, and "archived" is the only way to see them.
 */
export type EntryFilter = "all" | "favorites" | "archived";

/**
 * A partial update: omitted fields are left exactly as they are. Send `note: ""`
 * to clear a note back to null; the server rejects a body with no fields at all.
 */
export interface UpdateEntryInput {
  favorite?: boolean;
  archived?: boolean;
  note?: string;
}

export interface EntryListPage {
  items: EntryDTO[];
  nextCursor: string | null;
}

export interface TagCountDTO {
  tag: string;
  /** How many non-archived entries carry the tag — exactly what /tags/:tag lists. */
  count: number;
}

export interface TagListResponse {
  items: TagCountDTO[];
}

export interface SearchResults {
  items: EntryDTO[];
}

export interface RelatedEntryDTO {
  id: string;
  title: string | null;
  sourceDomain: string | null;
  takeaway: string | null;
  score: number;
}

/**
 * `available: false` means there is nothing to compute related entries from —
 * no vector index, or this entry was never embedded — as opposed to
 * `available: true` with an empty `items`, which means it simply has no
 * neighbours yet. The UI hides the section for both; the flag is what tells the
 * two apart without asking again.
 */
export interface RelatedEntriesResponse {
  available: boolean;
  items: RelatedEntryDTO[];
}

export interface CreateEntryResponse {
  id: string;
  status: EntryStatus;
  /** The URL-phase guess (P25), so the optimistic pending card can already carry
   * the right badge. Ingest may still refine it. Additive. */
  contentType: ContentType;
}

export type DigestStatus = "pending" | "ready" | "failed";

/**
 * 'weekly' is the roundup of external candidates; 'monthly-report' is the
 * retrospective over your own saved entries. Restated here rather than imported,
 * like every other DTO in this file — the client bundle stays free of worker and
 * `@til/core` code. Source of truth: `DIGEST_KINDS` in `@til/core`.
 */
export type DigestKind = "weekly" | "monthly-report";

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
  /** The base topical score: popularity, recency and cross-source corroboration. */
  score: number;
  /**
   * Similarity to the owner's recent saved reading, 0..1, or null when the run was
   * not personalized (no embedder, nothing indexed yet, or an embedder failure).
   */
  interestScore: number | null;
  why: string | null;
  evidence: DigestEvidenceDTO[];
}

export interface DigestSummaryDTO {
  id: string;
  runAt: number;
  windowDays: number;
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

export interface DigestListResponse {
  items: DigestSummaryDTO[];
}

export interface RunDigestInput {
  windowDays?: number;
  maxItems?: number;
  /** Omitted means 'weekly'; the server validates this strictly. */
  kind?: DigestKind;
}

export interface RunDigestResponse {
  id: string;
}

export interface FeedDTO {
  id: string;
  url: string;
  title: string | null;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface FeedListResponse {
  items: FeedDTO[];
}

export interface ChatToolCallDTO {
  name: string;
  args: unknown;
  result?: unknown;
}

export interface ChatMessageDTO {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ChatToolCallDTO[];
  createdAt: number;
}

export interface ChatConversationDTO {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
}

export interface ChatListResponse {
  items: ChatConversationDTO[];
}

export interface ChatMessagesResponse {
  messages: ChatMessageDTO[];
}

export interface ChatTicketDTO {
  ticket: string;
  expiresAt: number;
}

export type ReviewCardState = "new" | "learning" | "review";

/** 1 Again · 2 Hard · 3 Good · 4 Easy. */
export type ReviewGrade = 1 | 2 | 3 | 4;

/**
 * The question side of a card. The answer is deliberately absent — the review page
 * fetches the entry itself on reveal, so an un-revealed card holds no spoiler.
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

export interface ReviewQueueResponse {
  items: ReviewQueueItemDTO[];
  dueCount: number;
  /** Every enrolled card, due or not — 0 means the reader has never enrolled
   * anything, which is a different empty state from "caught up". */
  enrolledCount: number;
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

export interface ReviewEnrollResponse {
  enrolled: number;
  skipped: number;
}

export type FeedbackKind = "up" | "down";

/** Every reference is optional: a vote may be about a chat turn, an entry, or
 * neither. `kind` is the only thing the server requires. */
export interface FeedbackInput {
  kind: FeedbackKind;
  conversationId?: string;
  messageId?: string;
  entryId?: string;
  comment?: string;
}

export interface FeedbackDTO {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  entryId: string | null;
  kind: FeedbackKind;
  comment: string | null;
  createdAt: number;
}

/** One conversation's votes, oldest-first — so a fold over them ends on the
 * latest vote per message. */
export interface FeedbackListResponse {
  items: FeedbackDTO[];
}

export type LLMProvider = "openai" | "anthropic" | "groq";

export interface SettingsDTO {
  provider: LLMProvider;
  model: string;
  apiKeyMasked: string;
  cfAccountId: string;
  cfGatewayId: string;
  hasAigToken: boolean;
}

export interface SettingsInput {
  provider: LLMProvider;
  model: string;
  // Omit to keep the stored key — allowed only when provider/cfAccountId/cfGatewayId
  // are unchanged. Omit cfAigToken to keep the stored token; send "" to clear it.
  apiKey?: string;
  cfAccountId: string;
  cfGatewayId: string;
  cfAigToken?: string;
}

export interface TestConnectionResult {
  ok: boolean;
  detail?: string;
}

export type ApiErrorCode =
  | "unauthorized"
  | "invalid_url"
  | "unsafe_url"
  | "duplicate_url"
  | "not_found"
  | "validation_error"
  | "llm_error"
  | "rate_limited"
  | "network_error"
  | "unknown";

export class ApiError extends Error {
  code: ApiErrorCode;
  status: number;
  details: Record<string, unknown>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class DuplicateUrlError extends ApiError {
  existingId: string;
  constructor(message: string, existingId: string) {
    super("duplicate_url", message, 409, { existingId });
    this.name = "DuplicateUrlError";
    this.existingId = existingId;
  }
}

// Token store — single source; 401 anywhere clears and notifies subscribers.
type TokenListener = (token: string | null) => void;
const listeners = new Set<TokenListener>();

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // no-op — storage may be blocked
  }
  for (const l of listeners) l(token);
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // no-op
  }
  for (const l of listeners) l(null);
}

export function subscribeToken(fn: TokenListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const BASE: string =
  (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
  existingId?: string;
}

async function readErrorEnvelope(res: Response): Promise<ErrorEnvelope> {
  try {
    return (await res.json()) as ErrorEnvelope;
  } catch {
    return {};
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  const env = await readErrorEnvelope(res);
  const code = (env.error?.code ?? "unknown") as ApiErrorCode;
  const message = env.error?.message ?? `HTTP ${res.status}`;
  if (code === "duplicate_url" && typeof env.existingId === "string") {
    return new DuplicateUrlError(message, env.existingId);
  }
  return new ApiError(
    code,
    message,
    res.status,
    env as Record<string, unknown>,
  );
}

interface RequestOpts {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  skipAuth?: boolean;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const { method = "GET", body, query, skipAuth = false, signal } = opts;
  const url = new URL(BASE + path, window.location.origin);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "")
        url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (!skipAuth) {
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (e) {
    throw new ApiError(
      "network_error",
      e instanceof Error ? e.message : "network error",
      0,
    );
  }
  if (res.status === 401) {
    clearToken();
    throw new ApiError("unauthorized", "unauthorized", 401);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  // Some endpoints return 404 as a semantic "unset" — but per C5 we treat 404
  // as an error at the fetch level and let callers catch it (settings loader
  // maps the code to null).
  return (await res.json()) as T;
}

export interface DownloadedFile {
  blob: Blob;
  /** The server's `Content-Disposition` name, or a locally dated fallback. */
  filename: string;
}

/**
 * A file download that goes through the same auth and 401 handling as every other
 * call. Deliberately NOT `request`: that helper ends in `res.json()`, and this body
 * is an attachment — sometimes markdown, always something to hand to the browser's
 * downloader rather than to parse.
 *
 * The whole body is read into a Blob here. That is the price of authenticating with
 * a header instead of putting the app token in a URL (see `saveBlob`), and it is
 * paid on the side that can afford it: the worker still streams, so its memory
 * ceiling does not move with the size of the library.
 */
async function download(
  path: string,
  opts: { fallbackFilename: string; signal?: AbortSignal },
): Promise<DownloadedFile> {
  const url = new URL(BASE + path, window.location.origin);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url.toString(), { headers, signal: opts.signal });
  } catch (e) {
    throw new ApiError(
      "network_error",
      e instanceof Error ? e.message : "network error",
      0,
    );
  }
  if (res.status === 401) {
    clearToken();
    throw new ApiError("unauthorized", "unauthorized", 401);
  }
  if (!res.ok) {
    throw await toApiError(res);
  }
  return {
    blob: await res.blob(),
    filename:
      filenameFromDisposition(res.headers.get("content-disposition")) ??
      opts.fallbackFilename,
  };
}

export const api = {
  health(): Promise<{ ok: boolean }> {
    return request("/api/health", { skipAuth: true });
  },
  listEntries(params: {
    cursor?: string | null;
    limit?: number;
    filter?: EntryFilter;
    tag?: string;
    signal?: AbortSignal;
  }): Promise<EntryListPage> {
    return request("/api/entries", {
      query: {
        cursor: params.cursor ?? undefined,
        limit: params.limit ?? 20,
        // "all" is the server default, so it is left off the wire entirely.
        filter: params.filter === "all" ? undefined : params.filter,
        tag: params.tag,
      },
      signal: params.signal,
    });
  },
  listTags(signal?: AbortSignal): Promise<TagListResponse> {
    return request("/api/tags", { signal });
  },
  getEntry(id: string, signal?: AbortSignal): Promise<EntryDetailDTO> {
    return request(`/api/entries/${encodeURIComponent(id)}`, { signal });
  },
  getRelatedEntries(
    id: string,
    params: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<RelatedEntriesResponse> {
    return request(`/api/entries/${encodeURIComponent(id)}/related`, {
      query: { limit: params.limit ?? 5 },
      signal: params.signal,
    });
  },
  createEntry(url: string): Promise<CreateEntryResponse> {
    return request("/api/entries", { method: "POST", body: { url } });
  },
  // Returns the detail shape, so the caller can drop it straight into the
  // ["entry", id] cache without losing contentMarkdown.
  updateEntry(id: string, patch: UpdateEntryInput): Promise<EntryDetailDTO> {
    return request(`/api/entries/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: patch,
    });
  },
  deleteEntry(id: string): Promise<void> {
    return request(`/api/entries/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  reingestEntry(id: string): Promise<CreateEntryResponse> {
    return request(`/api/entries/${encodeURIComponent(id)}/reingest`, {
      method: "POST",
    });
  },
  search(q: string, signal?: AbortSignal): Promise<SearchResults> {
    return request("/api/search", { query: { q, limit: 20 }, signal });
  },
  listDigests(
    params: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<DigestListResponse> {
    return request("/api/digests", {
      query: { limit: params.limit ?? 20 },
      signal: params.signal,
    });
  },
  getDigest(id: string, signal?: AbortSignal): Promise<DigestDetailDTO> {
    return request(`/api/digests/${encodeURIComponent(id)}`, { signal });
  },
  runDigest(input: RunDigestInput = {}): Promise<RunDigestResponse> {
    // Always send an object: a JSON body validator would reject an empty body.
    return request("/api/digests/run", { method: "POST", body: input });
  },
  deleteDigest(id: string): Promise<void> {
    return request(`/api/digests/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  listFeeds(signal?: AbortSignal): Promise<FeedListResponse> {
    return request("/api/feeds", { signal });
  },
  createFeed(url: string): Promise<FeedDTO> {
    return request("/api/feeds", { method: "POST", body: { url } });
  },
  setFeedEnabled(id: string, enabled: boolean): Promise<FeedDTO> {
    return request(`/api/feeds/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: { enabled },
    });
  },
  deleteFeed(id: string): Promise<void> {
    return request(`/api/feeds/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  reviewQueue(
    params: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ReviewQueueResponse> {
    return request("/api/reviews/queue", {
      query: { limit: params.limit ?? 10 },
      signal: params.signal,
    });
  },
  gradeReview(entryId: string, grade: ReviewGrade): Promise<ReviewScheduleDTO> {
    return request(`/api/reviews/${encodeURIComponent(entryId)}`, {
      method: "POST",
      body: { grade },
    });
  },
  enrollReview(
    input: { entryId: string } | { all: true },
  ): Promise<ReviewEnrollResponse> {
    return request("/api/reviews/enroll", { method: "POST", body: input });
  },
  submitFeedback(input: FeedbackInput): Promise<FeedbackDTO> {
    return request("/api/feedback", { method: "POST", body: input });
  },
  listFeedback(
    conversationId: string,
    signal?: AbortSignal,
  ): Promise<FeedbackListResponse> {
    return request("/api/feedback", { query: { conversationId }, signal });
  },
  listChats(
    params: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChatListResponse> {
    return request("/api/chat", {
      query: { limit: params.limit ?? 50 },
      signal: params.signal,
    });
  },
  getChatMessages(
    id: string,
    signal?: AbortSignal,
  ): Promise<ChatMessagesResponse> {
    return request(`/api/chat/${encodeURIComponent(id)}/messages`, { signal });
  },
  deleteChat(id: string): Promise<void> {
    return request(`/api/chat/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  // The chat WebSocket handshake cannot carry an Authorization header, so it
  // carries a short-lived ticket minted here instead — routed through `request`
  // so a stale token still clears the session exactly once, in one place.
  mintChatTicket(): Promise<ChatTicketDTO> {
    return request("/api/chat/ticket", { method: "POST" });
  },
  getSettings(signal?: AbortSignal): Promise<SettingsDTO | null> {
    return request<SettingsDTO>("/api/settings", { signal }).catch(
      (e: unknown) => {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      },
    );
  },
  putSettings(input: SettingsInput): Promise<SettingsDTO> {
    return request("/api/settings", { method: "PUT", body: input });
  },
  testSettings(): Promise<TestConnectionResult> {
    return request("/api/settings/test", { method: "POST" });
  },
  exportBackup(
    format: ExportFormat,
    signal?: AbortSignal,
  ): Promise<DownloadedFile> {
    const path =
      format === "markdown" ? "/api/export?format=markdown" : "/api/export";
    return download(path, {
      fallbackFilename: fallbackExportFilename(format, Date.now()),
      signal,
    });
  },
};
