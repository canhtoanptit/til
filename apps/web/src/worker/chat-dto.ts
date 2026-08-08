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

export interface ChatSummaryDTO {
  id: string;
  title: string | null;
  updatedAt: number;
  messageCount: number;
}

/** Longest conversation title derived from the opening user message. */
export const CHAT_TITLE_MAX_CHARS = 80;

interface RawPart {
  type?: unknown;
  text?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
}

interface RawMessage {
  id?: unknown;
  role?: unknown;
  parts?: unknown;
}

/**
 * Flattens one persisted UI message into the wire shape. Returns null for
 * anything that is not a user or assistant turn (system turns, malformed rows),
 * so callers can `filter`.
 */
export function toChatMessageDTO(
  message: unknown,
  createdAt: number,
): ChatMessageDTO | null {
  if (typeof message !== "object" || message === null) return null;
  const raw = message as RawMessage;
  const role = raw.role;
  if (role !== "user" && role !== "assistant") return null;
  const id = typeof raw.id === "string" ? raw.id : null;
  if (id === null) return null;

  const parts: RawPart[] = Array.isArray(raw.parts)
    ? (raw.parts as RawPart[])
    : [];
  const text: string[] = [];
  const toolCalls: ChatToolCallDTO[] = [];
  for (const part of parts) {
    if (typeof part !== "object" || part === null) continue;
    const type = typeof part.type === "string" ? part.type : "";
    if (type === "text") {
      if (typeof part.text === "string" && part.text.length > 0) {
        text.push(part.text);
      }
      continue;
    }
    const name = toolName(type, part.toolName);
    if (name === null) continue;
    toolCalls.push({
      name,
      args: part.input ?? null,
      ...("output" in part ? { result: part.output } : {}),
    });
  }

  return {
    id,
    role,
    content: text.join("\n"),
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    createdAt,
  };
}

/**
 * SQLite `current_timestamp` is UTC "YYYY-MM-DD HH:MM:SS" with no zone marker,
 * which `Date.parse` would otherwise read as local time.
 */
export function parseStamp(value: string | number | null): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return 0;
  const parsed = Date.parse(value.includes("T") ? value : `${value}Z`);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function chatTitleFrom(content: string): string | null {
  const collapsed = content.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= CHAT_TITLE_MAX_CHARS
    ? collapsed
    : `${collapsed.slice(0, CHAT_TITLE_MAX_CHARS)}…`;
}

// The AI SDK spells a server tool part `tool-<name>` and a client-registered one
// `dynamic-tool` with the name in a field.
function toolName(type: string, declared: unknown): string | null {
  if (type === "dynamic-tool") {
    return typeof declared === "string" && declared.length > 0
      ? declared
      : null;
  }
  if (!type.startsWith("tool-")) return null;
  if (typeof declared === "string" && declared.length > 0) return declared;
  const suffix = type.slice("tool-".length);
  return suffix.length > 0 ? suffix : null;
}
