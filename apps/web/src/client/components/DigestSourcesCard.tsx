import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { ApiError, api, type FeedDTO } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { ErrorBanner, friendlyMessage } from "./ErrorBanner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

export function DigestSourcesCard() {
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const feedsQuery = useQuery({
    queryKey: ["feeds"] as const,
    queryFn: ({ signal }) => api.listFeeds(signal),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["feeds"] });
  };

  const add = useMutation({
    mutationFn: (raw: string) => api.createFeed(raw),
    onSuccess: (feed) => {
      setUrl("");
      toast.success("Source added", { description: feedHost(feed.url) });
      invalidate();
    },
    onError: (e) => {
      // A 409 is not really a failure — the source the owner wanted is present.
      if (e instanceof ApiError && e.code === "duplicate_url") {
        setUrl("");
        toast.info("That source is already in your list");
        invalidate();
        return;
      }
      toast.error("Could not add that source", {
        description: friendlyMessage(e),
      });
    },
  });

  const toggle = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api.setFeedEnabled(vars.id, vars.enabled),
    onSuccess: (feed) => {
      toast.success(feed.enabled ? "Source enabled" : "Source disabled", {
        description: feedHost(feed.url),
      });
      invalidate();
    },
    onError: (e) => {
      toast.error("Could not update that source", {
        description: friendlyMessage(e),
      });
      // The switch is driven by server state, so a refetch un-does the flip.
      invalidate();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteFeed(id),
    onSuccess: () => {
      setConfirmId(null);
      toast.success("Source removed");
      invalidate();
    },
    onError: (e) => {
      setConfirmId(null);
      toast.error("Could not remove that source", {
        description: friendlyMessage(e),
      });
    },
  });

  function onAdd(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    add.mutate(trimmed);
  }

  const items = feedsQuery.data?.items ?? [];
  const enabledCount = items.filter((f) => f.enabled).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Digest sources</CardTitle>
        <CardDescription>
          RSS and Atom feeds the weekly digest polls, on top of Hacker News,
          Lobsters and arXiv. Disable one to skip it without losing the URL.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={onAdd} className="flex flex-col gap-2 sm:flex-row">
          <Label htmlFor="feed-url" className="sr-only">
            Feed URL
          </Label>
          <Input
            id="feed-url"
            type="url"
            required
            placeholder="https://example.com/feed.xml"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1"
            disabled={add.isPending}
          />
          <Button type="submit" disabled={add.isPending || !url.trim()}>
            {add.isPending ? "Adding…" : "Add source"}
          </Button>
        </form>

        {feedsQuery.isLoading ? (
          <div className="space-y-2">
            <RowSkeleton />
            <RowSkeleton />
            <RowSkeleton />
          </div>
        ) : feedsQuery.isError ? (
          <ErrorBanner
            error={feedsQuery.error}
            onRetry={() => feedsQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
            No feeds yet. The digest still runs on Hacker News, Lobsters and
            arXiv — add a feed to widen it.
          </p>
        ) : (
          <>
            <ul className="divide-y rounded-md border">
              {items.map((feed) => (
                <li key={feed.id}>
                  <FeedRow
                    feed={feed}
                    busy={toggle.isPending && toggle.variables?.id === feed.id}
                    confirming={confirmId === feed.id}
                    deleting={remove.isPending && remove.variables === feed.id}
                    onToggle={(enabled) =>
                      toggle.mutate({ id: feed.id, enabled })
                    }
                    onConfirmingChange={(open) =>
                      setConfirmId(open ? feed.id : null)
                    }
                    onConfirmDelete={() => remove.mutate(feed.id)}
                  />
                </li>
              ))}
            </ul>
            {enabledCount === 0 && (
              <p className="text-xs text-warning" role="status">
                Every feed is disabled — the digest will run on Hacker News,
                Lobsters and arXiv only.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function FeedRow({
  feed,
  busy,
  confirming,
  deleting,
  onToggle,
  onConfirmingChange,
  onConfirmDelete,
}: {
  feed: FeedDTO;
  busy: boolean;
  confirming: boolean;
  deleting: boolean;
  onToggle: (enabled: boolean) => void;
  onConfirmingChange: (open: boolean) => void;
  onConfirmDelete: () => void;
}) {
  const label = feed.title ?? feedHost(feed.url);
  return (
    <div className="flex items-center gap-3 p-3">
      <Switch
        checked={feed.enabled}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`${feed.enabled ? "Disable" : "Enable"} source: ${label}`}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{label}</p>
        <a
          href={feed.url}
          target="_blank"
          rel="noreferrer noopener"
          className="block truncate text-xs text-muted-foreground hover:underline"
          title={feed.url}
        >
          {feed.url}
        </a>
      </div>
      {!feed.enabled && (
        <span className="shrink-0 text-xs text-muted-foreground">Disabled</span>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={onConfirmingChange}
        trigger={
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            aria-label={`Remove source: ${label}`}
          >
            Remove
          </Button>
        }
        title="Remove this source?"
        description={`${feed.url} will no longer be polled for the digest. Disable it instead if you only want to pause it.`}
        confirmLabel="Remove permanently"
        pendingLabel="Removing…"
        pending={deleting}
        onConfirm={onConfirmDelete}
      />
    </div>
  );
}

function RowSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 rounded-md border p-3"
    >
      <Skeleton className="h-5 w-9 rounded-full" />
      <div className="flex-1">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
    </div>
  );
}

function feedHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
