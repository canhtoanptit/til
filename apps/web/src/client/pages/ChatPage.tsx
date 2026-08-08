import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { api, getToken } from "../api";
import { ChatErrorBoundary } from "../components/ChatErrorBoundary";
import { ChatMessageView } from "../components/ChatMessageView";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { chatConversationTitle } from "../components/chat-format";

/** The signed ticket lives 60s server-side; re-mint well inside that so a
 * partysocket reconnect never presents an expired one. */
const TICKET_CACHE_TTL_MS = 30_000;

const SUGGESTIONS = [
  "What have I saved about CSS?",
  "What did I read most this month?",
  "What should I revisit?",
  "Which tags come up most in my saves?",
];

export function ChatPage() {
  const params = useParams();
  const id = params.id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const listQuery = useQuery({
    queryKey: ["chats"] as const,
    queryFn: ({ signal }) => api.listChats({ limit: 50, signal }),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteChat(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["chats"] });
      navigate("/chat");
    },
  });

  const summary = listQuery.data?.items.find((c) => c.id === id);
  const heading = summary ? chatConversationTitle(summary) : "New chat";

  if (id.length === 0) {
    return (
      <div className="rounded border border-slate-200 bg-white p-6 text-center">
        <p className="text-sm text-slate-600">That conversation doesn't exist.</p>
        <Link
          to="/chat"
          className="mt-3 inline-block text-sm font-medium text-slate-900 underline"
        >
          Back to chat
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to="/chat" className="text-sm text-slate-500 hover:underline">
          ← All conversations
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 flex-1 text-lg font-semibold text-slate-900">
          {heading}
        </h1>
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
          >
            Delete
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-xs text-slate-600">Delete this conversation?</span>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {remove.isPending ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        )}
      </header>

      {remove.isError && (
        <p className="text-sm text-red-700" role="alert">
          {friendlyMessage(remove.error)}
        </p>
      )}

      <ChatErrorBoundary onReset={() => setAttempt((n) => n + 1)}>
        <Suspense fallback={<Spinner label="Connecting to your reading…" />}>
          <Conversation
            key={`${id}:${attempt}`}
            conversationId={id}
            attempt={attempt}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Suspense>
      </ChatErrorBoundary>
    </div>
  );
}

function Conversation({
  conversationId,
  attempt,
  onRetry,
}: {
  conversationId: string;
  attempt: number;
  onRetry: () => void;
}) {
  const qc = useQueryClient();
  const token = getToken() ?? "";
  const [draft, setDraft] = useState("");
  const [ticketError, setTicketError] = useState<unknown>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // WHY swallow instead of reject: `useAgent` resolves this with React `use()`,
  // so a rejection would throw during render. `request` has already cleared the
  // token on a 401, which flips the app back to the sign-in gate by itself.
  const mintTicket = useCallback(async (): Promise<Record<string, string>> => {
    try {
      const { ticket } = await api.mintChatTicket();
      setTicketError(null);
      return { ticket };
    } catch (err) {
      setTicketError(err);
      return {};
    }
  }, []);

  const queryDeps = useMemo(() => [attempt], [attempt]);
  const headers = useMemo(
    () => ({ authorization: `Bearer ${token}` }),
    [token],
  );

  const agent = useAgent({
    agent: "CHAT",
    name: conversationId,
    // Our routes live under /api, not the SDK default /agents.
    prefix: "api",
    query: mintTicket,
    queryDeps,
    cacheTtl: TICKET_CACHE_TTL_MS,
    // Without a ticket the handshake can only ever be rejected, so stop
    // reconnecting and wait for the explicit Retry instead.
    enabled: ticketError === null,
  });

  const {
    messages,
    sendMessage,
    status,
    error,
    clearError,
    stop,
    isStreaming,
    isRecovering,
    connectionError,
  } = useAgentChat({
    agent,
    // The initial GET <agentUrl>/get-messages is plain HTTP and silently
    // returns [] without this.
    headers,
  });

  const busy = isStreaming || isRecovering || status === "submitted";
  const settled = !busy && messages.length > 0;

  useEffect(() => {
    if (settled) void qc.invalidateQueries({ queryKey: ["chats"] });
  }, [settled, qc]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, busy]);

  function send() {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    setDraft("");
    void sendMessage({ text });
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    e.preventDefault();
    send();
  }

  function fillDraft(text: string) {
    setDraft(text);
    textareaRef.current?.focus();
  }

  const blocked = ticketError !== null || connectionError !== null;

  return (
    <div className="space-y-4">
      {ticketError !== null && (
        <ErrorBanner error={ticketError} onRetry={onRetry} />
      )}

      {ticketError === null && connectionError !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p>
            Lost the connection to the chat agent
            {connectionError.reason ? (
              <>
                : <span className="italic">{connectionError.reason}</span>
              </>
            ) : (
              "."
            )}
          </p>
          <button
            type="button"
            onClick={onRetry}
            className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Reconnect
          </button>
        </div>
      )}

      <section
        aria-label="Conversation"
        role="log"
        aria-live="polite"
        aria-busy={busy}
        className="space-y-4"
      >
        {messages.length === 0 && !busy ? (
          <Primer disabled={blocked} onPick={fillDraft} />
        ) : (
          messages.map((message) => (
            <ChatMessageView key={message.id} message={message} />
          ))
        )}
        {status === "submitted" && !isStreaming && (
          <Spinner label="Reading your entries…" />
        )}
        {isRecovering && <Spinner label="Recovering the answer…" />}
        <div ref={bottomRef} />
      </section>

      {error !== undefined && (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p className="font-medium">The assistant couldn't finish that answer.</p>
          <p className="mt-1 italic">{friendlyMessage(error)}</p>
          <p className="mt-1">
            Ask again, or check the provider and model in{" "}
            <Link to="/settings" className="underline">
              Settings
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={() => clearError()}
            className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100"
          >
            Dismiss
          </button>
        </div>
      )}

      <form
        className="sticky bottom-0 space-y-2 border-t border-slate-200 bg-slate-50 pb-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="til-chat-input" className="sr-only">
          Ask about your saved reading
        </label>
        <textarea
          id="til-chat-input"
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || blocked}
          placeholder="Ask about your saved reading…  (Enter to send, Shift+Enter for a new line)"
          className="w-full resize-y rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none disabled:bg-slate-100"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-slate-500">
            {blocked
              ? "Not connected."
              : busy
                ? "Answering…"
                : "Answers come only from your saved entries."}
          </span>
          <div className="flex items-center gap-2">
            {busy && (
              <button
                type="button"
                onClick={() => void stop()}
                className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
              >
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={busy || blocked || draft.trim().length === 0}
              className="rounded bg-slate-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Primer({
  disabled,
  onPick,
}: {
  disabled: boolean;
  onPick: (text: string) => void;
}) {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-6 text-sm text-slate-600">
      <p className="font-medium text-slate-800">Ask about what you've saved.</p>
      <p className="mt-1">
        The assistant searches your entries and cites them, so you can click
        through to the original.
      </p>
      <ul className="mt-4 flex flex-wrap gap-2">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(text)}
              className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {text}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
