import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { api, type ChatConversationDTO } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
      toast.success("Conversation deleted");
      void qc.invalidateQueries({ queryKey: ["chats"] });
    },
    onError: (e) => {
      setConfirmId(null);
      toast.error("Could not delete that conversation", {
        description: friendlyMessage(e),
      });
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Chat</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Ask questions about the things you have saved. Answers only ever
            come from your own entries.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => void navigate(`/chat/${crypto.randomUUID()}`)}
        >
          New chat
        </Button>
      </header>

      <section aria-label="Conversations">
        {listQuery.isLoading ? (
          <div className="space-y-3">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : listQuery.isError ? (
          <ErrorBanner
            error={listQuery.error}
            onRetry={() => listQuery.refetch()}
          />
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
                  onConfirmingChange={(open) =>
                    setConfirmId(open ? chat.id : null)
                  }
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
  onConfirmingChange,
  onConfirmDelete,
}: {
  chat: ChatConversationDTO;
  confirming: boolean;
  deleting: boolean;
  onConfirmingChange: (open: boolean) => void;
  onConfirmDelete: () => void;
}) {
  const title = chatConversationTitle(chat);
  return (
    <Card asChild className="gap-0 p-4 transition-shadow hover:shadow-md">
      <article>
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`/chat/${encodeURIComponent(chat.id)}`}
            className="min-w-0 flex-1 text-base font-semibold hover:underline"
          >
            {title}
          </Link>
          <ConfirmDialog
            open={confirming}
            onOpenChange={onConfirmingChange}
            trigger={
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="shrink-0"
                aria-label={`Delete conversation: ${title}`}
              >
                Delete
              </Button>
            }
            title="Delete this conversation?"
            description={`"${title}" and all of its messages will be removed permanently. This cannot be undone.`}
            confirmLabel="Delete permanently"
            pendingLabel="Deleting…"
            pending={deleting}
            onConfirm={onConfirmDelete}
          />
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span title={formatChatDate(chat.updatedAt)}>
            {formatRelative(chat.updatedAt)}
          </span>
          <span aria-hidden="true">·</span>
          <span>{formatMessageCount(chat.messageCount)}</span>
        </div>
      </article>
    </Card>
  );
}

function RowSkeleton() {
  return (
    <Card aria-hidden="true" className="gap-0 p-4">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-2 h-3 w-1/3" />
    </Card>
  );
}

function EmptyState() {
  return (
    <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
      <p className="font-medium text-foreground">No conversations yet.</p>
      <p className="mt-1">
        Start one and ask things like{" "}
        <span className="font-medium">“what have I saved about CSS?”</span>,{" "}
        <span className="font-medium">“what did I read most this month?”</span>{" "}
        or <span className="font-medium">“what should I revisit?”</span>
      </p>
      <p className="mt-1">
        It searches your saved entries and links back to them, so you can always
        check the source.
      </p>
    </Card>
  );
}
