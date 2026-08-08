const TOKEN_KEY = "til:token";

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

export interface EntryListPage {
  items: EntryDTO[];
  nextCursor: string | null;
}

export interface SearchResults {
  items: EntryDTO[];
}

export interface CreateEntryResponse {
  id: string;
  status: EntryStatus;
}

export type DigestStatus = "pending" | "ready" | "failed";

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

export interface DigestListResponse {
  items: DigestSummaryDTO[];
}

export interface RunDigestInput {
  windowDays?: number;
  maxItems?: number;
}

export interface RunDigestResponse {
  id: string;
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

const BASE: string = (import.meta.env.VITE_API_BASE as string | undefined) ?? "";

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
  return new ApiError(code, message, res.status, env as Record<string, unknown>);
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
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
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

export const api = {
  health(): Promise<{ ok: boolean }> {
    return request("/api/health", { skipAuth: true });
  },
  listEntries(params: {
    cursor?: string | null;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<EntryListPage> {
    return request("/api/entries", {
      query: {
        cursor: params.cursor ?? undefined,
        limit: params.limit ?? 20,
      },
      signal: params.signal,
    });
  },
  getEntry(id: string, signal?: AbortSignal): Promise<EntryDetailDTO> {
    return request(`/api/entries/${encodeURIComponent(id)}`, { signal });
  },
  createEntry(url: string): Promise<CreateEntryResponse> {
    return request("/api/entries", { method: "POST", body: { url } });
  },
  deleteEntry(id: string): Promise<void> {
    return request(`/api/entries/${encodeURIComponent(id)}`, { method: "DELETE" });
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
    return request(`/api/digests/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
  listChats(
    params: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<ChatListResponse> {
    return request("/api/chat", {
      query: { limit: params.limit ?? 50 },
      signal: params.signal,
    });
  },
  getChatMessages(id: string, signal?: AbortSignal): Promise<ChatMessagesResponse> {
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
    return request<SettingsDTO>("/api/settings", { signal }).catch((e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    });
  },
  putSettings(input: SettingsInput): Promise<SettingsDTO> {
    return request("/api/settings", { method: "PUT", body: input });
  },
  testSettings(): Promise<TestConnectionResult> {
    return request("/api/settings/test", { method: "POST" });
  },
};
