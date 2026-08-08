import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, type ChatConversationDTO } from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Skeleton } from "../components/Skeleton";
import {
  chatConversationTitle,
  formatChatDate,
  formatMessageCount,
  formatRelative,
} from "../components/chat-format";

export function ChatListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["chats"] as const,
    queryFn: ({ signal }) => api.listChats({ limit: 50, signal }),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteChat(id),
    onSuccess: () => {
      setConfirmId(null);
      void qc.invalidateQueries({ queryKey: ["chats"] });
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Chat</h1>
          <p className="mt-1 text-sm text-slate-600">
            Ask questions about the things you have saved. Answers only ever come
            from your own entries.
          </p>
        </div>
        <button
          type="button"
          onClick={() => navigate(`/chat/${crypto.randomUUID()}`)}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          New chat
        </button>
      </header>

      {remove.isError && (
        <p className="text-sm text-red-700" role="alert">
          {friendlyMessage(remove.error)}
        </p>
      )}

      <section aria-label="Conversations">
        {listQuery.isLoading ? (
          <div className="space-y-3">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : listQuery.isError ? (
          <ErrorBanner error={listQuery.error} onRetry={() => listQuery.refetch()} />
        ) : items.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-3">
            {items.map((chat) => (
              <li key={chat.id}>
                <ConversationRow
                  chat={chat}
                  confirming={confirmId === chat.id}
                  deleting={remove.isPending && remove.variables === chat.id}
                  onAskDelete={() => setConfirmId(chat.id)}
                  onCancelDelete={() => setConfirmId(null)}
                  onConfirmDelete={() => remove.mutate(chat.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ConversationRow({
  chat,
  confirming,
  deleting,
  onAskDelete,
  onCancelDelete,
  onConfirmDelete,
}: {
  chat: ChatConversationDTO;
  confirming: boolean;
  deleting: boolean;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
}) {
  const title = chatConversationTitle(chat);
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/chat/${encodeURIComponent(chat.id)}`}
          className="min-w-0 flex-1 text-base font-semibold text-slate-900 hover:underline"
        >
          {title}
        </Link>
        {!confirming ? (
          <button
            type="button"
            onClick={onAskDelete}
            className="shrink-0 rounded border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            aria-label={`Delete conversation: ${title}`}
          >
            Delete
          </button>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onConfirmDelete}
              disabled={deleting}
              className="rounded bg-red-600 px-2 py-1 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {deleting ? "Deleting…" : "Confirm"}
            </button>
            <button
              type="button"
              onClick={onCancelDelete}
              className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        <span title={formatChatDate(chat.updatedAt)}>
          {formatRelative(chat.updatedAt)}
        </span>
        <span aria-hidden="true">·</span>
        <span>{formatMessageCount(chat.messageCount)}</span>
      </div>
    </article>
  );
}

function RowSkeleton() {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-2 h-3 w-1/3" />
    </article>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      <p className="font-medium text-slate-700">No conversations yet.</p>
      <p className="mt-1">
        Start one and ask things like{" "}
        <span className="font-medium">“what have I saved about CSS?”</span>,{" "}
        <span className="font-medium">“what did I read most this month?”</span> or{" "}
        <span className="font-medium">“what should I revisit?”</span>
      </p>
      <p className="mt-1">
        It searches your saved entries and links back to them, so you can always
        check the source.
      </p>
    </div>
  );
}
