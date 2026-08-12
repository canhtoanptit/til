import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { toast } from "sonner";
import { api, getToken } from "../api";
import { ChatErrorBoundary } from "../components/ChatErrorBoundary";
import { ChatMessageView } from "../components/ChatMessageView";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { chatConversationTitle, entryChatSeed } from "../components/chat-format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

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
  const [searchParams] = useSearchParams();
  const [attempt, setAttempt] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const listQuery = useQuery({
    queryKey: ["chats"] as const,
    queryFn: ({ signal }) => api.listChats({ limit: 50, signal }),
  });

  // "Ask about this entry" arrives as `?about=<entryId>`. The key matches the
  // detail page's, so the entry is already in cache and the seed appears without
  // a visible fetch; if it isn't (reload, shared link) one cheap GET fills it in.
  const aboutId = searchParams.get("about") ?? "";
  const aboutQuery = useQuery({
    queryKey: ["entry", aboutId] as const,
    queryFn: ({ signal }) => api.getEntry(aboutId, signal),
    enabled: aboutId.length > 0,
    retry: false,
  });
  // Waiting for the title to settle keeps the seed from being written twice, once
  // without a title. A failed lookup still seeds — the id alone is what
  // `get_entry` needs.
  const seedDraft =
    aboutId.length > 0 && !aboutQuery.isPending
      ? entryChatSeed({ id: aboutId, title: aboutQuery.data?.title ?? null })
      : null;

  const remove = useMutation({
    mutationFn: () => api.deleteChat(id),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success("Conversation deleted");
      void qc.invalidateQueries({ queryKey: ["chats"] });
      void navigate("/chat");
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.error("Could not delete that conversation", {
        description: friendlyMessage(e),
      });
    },
  });

  const summary = listQuery.data?.items.find((c) => c.id === id);
  const heading = summary ? chatConversationTitle(summary) : "New chat";

  if (id.length === 0) {
    return (
      <Card className="gap-0 p-6 text-center">
        <p className="text-sm text-muted-foreground">
          That conversation doesn't exist.
        </p>
        <Button asChild variant="link" className="mt-3">
          <Link to="/chat">Back to chat</Link>
        </Button>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link to="/chat" className="text-sm text-muted-foreground hover:underline">
          ← All conversations
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 flex-1 text-lg font-semibold">{heading}</h1>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          trigger={
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="shrink-0"
              aria-label={`Delete conversation: ${heading}`}
            >
              Delete
            </Button>
          }
          title="Delete this conversation?"
          description={`"${heading}" and all of its messages will be removed permanently. This cannot be undone.`}
          confirmLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </header>

      <ChatErrorBoundary onReset={() => setAttempt((n) => n + 1)}>
        <Suspense fallback={<Spinner label="Connecting to your reading…" />}>
          <Conversation
            key={`${id}:${attempt}`}
            conversationId={id}
            attempt={attempt}
            seedDraft={seedDraft}
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
  seedDraft,
  onRetry,
}: {
  conversationId: string;
  attempt: number;
  seedDraft: string | null;
  onRetry: () => void;
}) {
  const qc = useQueryClient();
  const token = getToken() ?? "";
  const [draft, setDraft] = useState("");
  const [ticketError, setTicketError] = useState<unknown>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const seeded = useRef(false);

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

  // WHY fill the composer instead of sending for the user: an auto-send would
  // have to fire exactly once, after the socket is open and after history has
  // hydrated — and StrictMode runs effects twice. Filling the box is
  // deterministic, shows the question before it is asked, and is editable.
  useEffect(() => {
    if (seeded.current || seedDraft === null || messages.length > 0) return;
    seeded.current = true;
    setDraft(seedDraft);
    textareaRef.current?.focus();
  }, [seedDraft, messages.length]);

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
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
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
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={onRetry}
          >
            Reconnect
          </Button>
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
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
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
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => clearError()}
          >
            Dismiss
          </Button>
        </div>
      )}

      <form
        className="sticky bottom-0 space-y-2 border-t bg-background pb-4 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <label htmlFor="til-chat-input" className="sr-only">
          Ask about your saved reading
        </label>
        <Textarea
          id="til-chat-input"
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy || blocked}
          placeholder="Ask about your saved reading…  (Enter to send, Shift+Enter for a new line)"
          className="min-h-16 resize-y text-sm"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {blocked
              ? "Not connected."
              : busy
                ? "Answering…"
                : "Answers come only from your saved entries."}
          </span>
          <div className="flex items-center gap-2">
            {busy && (
              <Button type="button" variant="outline" onClick={() => void stop()}>
                Stop
              </Button>
            )}
            <Button
              type="submit"
              disabled={busy || blocked || draft.trim().length === 0}
            >
              Send
            </Button>
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
    <Card className="gap-0 border-dashed bg-transparent p-6 text-sm text-muted-foreground shadow-none">
      <p className="font-medium text-foreground">Ask about what you've saved.</p>
      <p className="mt-1">
        The assistant searches your entries and cites them, so you can click
        through to the original.
      </p>
      <ul className="mt-4 flex flex-wrap gap-2">
        {SUGGESTIONS.map((text) => (
          <li key={text}>
            <Button
              type="button"
              variant="outline"
              size="xs"
              className="rounded-full"
              disabled={disabled}
              onClick={() => onPick(text)}
            >
              {text}
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
