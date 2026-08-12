import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ChevronDownIcon } from "lucide-react";
import { ApiError, api, type RelatedEntryDTO } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

function RelatedRow({ item }: { item: RelatedEntryDTO }) {
  return (
    <Card asChild className="gap-0 p-3 transition-shadow hover:shadow-md">
      <article>
        <Link
          to={`/entries/${encodeURIComponent(item.id)}`}
          className="text-sm font-semibold hover:underline"
        >
          {item.title?.trim() || item.id}
        </Link>
        {item.sourceDomain && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.sourceDomain}
          </p>
        )}
        {item.takeaway && (
          <p className="mt-1.5 line-clamp-2 text-sm text-muted-foreground">
            {item.takeaway}
          </p>
        )}
      </article>
    </Card>
  );
}

export function EntryDetailPage() {
  const params = useParams();
  const id = params.id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const markdownId = useId();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const query = useQuery({
    queryKey: ["entry", id] as const,
    queryFn: ({ signal }) => api.getEntry(id, signal),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
    enabled: id.length > 0,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  // Only ready entries have a vector, so only they can have neighbours. Failures
  // stay silent: "Related" is an extra, and an error banner for it would shout
  // over the entry the page exists to show.
  const relatedQuery = useQuery({
    queryKey: ["entry", id, "related"] as const,
    queryFn: ({ signal }) => api.getRelatedEntries(id, { limit: 5, signal }),
    enabled: id.length > 0 && query.data?.status === "ready",
    retry: false,
  });

  const reingest = useMutation({
    mutationFn: () => api.reingestEntry(id),
    onSuccess: () => {
      toast.success("Reingesting", { description: "Fetching the link again." });
      void qc.invalidateQueries({ queryKey: ["entry", id] });
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => {
      toast.error("Reingest failed", { description: friendlyMessage(e) });
    },
  });

  // Enrolling twice is a server-side no-op, so this button needs no "is it already
  // enrolled?" query — the response tells us which of the two things happened.
  const enroll = useMutation({
    mutationFn: () => api.enrollReview({ entryId: id }),
    onSuccess: (result) => {
      if (result.enrolled === 0) {
        toast.info("Already in your review queue");
      } else {
        toast.success("Added to your review queue", {
          description: "It's due right away.",
        });
      }
      void qc.invalidateQueries({ queryKey: ["reviews"] });
    },
    onError: (e) => {
      toast.error("Could not add this to review", {
        description: friendlyMessage(e),
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteEntry(id),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success("Entry deleted");
      void qc.invalidateQueries({ queryKey: ["entries"] });
      void navigate("/");
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.error("Could not delete that entry", {
        description: friendlyMessage(e),
      });
    },
  });

  if (query.isLoading) {
    return <Spinner label="Loading entry…" />;
  }

  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <Card className="gap-0 p-6 text-center">
          <p className="text-sm text-muted-foreground">This entry doesn't exist.</p>
          <Button asChild variant="link" className="mt-3">
            <Link to="/">Back to feed</Link>
          </Button>
        </Card>
      );
    }
    return <ErrorBanner error={err} onRetry={() => query.refetch()} />;
  }

  const entry = query.data;
  if (!entry) return null;

  const title = entry.title?.trim() || entry.canonicalUrl;
  const related = relatedQuery.data?.items ?? [];

  return (
    <article className="space-y-5">
      <div>
        <Link to="/" className="text-sm text-muted-foreground hover:underline">
          ← Back
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            {title}
          </a>
        </h1>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          {entry.sourceDomain && <span>{entry.sourceDomain}</span>}
          {entry.sourceDomain && <span aria-hidden="true">·</span>}
          <span>{formatDate(entry.createdAt)}</span>
          {entry.status === "pending" && (
            <>
              <span aria-hidden="true">·</span>
              <Spinner label="ingesting…" />
            </>
          )}
        </div>
      </header>

      {entry.status === "failed" && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p className="font-medium">Ingest failed.</p>
          {entry.error && <p className="mt-1 italic">{entry.error}</p>}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => reingest.mutate()}
            disabled={reingest.isPending}
          >
            {reingest.isPending ? "Reingesting…" : "Reingest"}
          </Button>
        </div>
      )}

      {entry.status === "pending" && (
        <Card role="status" className="gap-0 p-3">
          <Spinner label="Waiting for the LLM to finish processing this link…" />
        </Card>
      )}

      {entry.status === "ready" && (
        <>
          {entry.takeaway && (
            <section
              aria-label="Takeaway"
              className="rounded-md border-l-4 border-success bg-success/10 p-4"
            >
              <h2 className="text-xs font-semibold uppercase tracking-wide text-success">
                Takeaway
              </h2>
              <p className="mt-1 text-base">{entry.takeaway}</p>
            </section>
          )}
          {entry.summary && (
            <section aria-label="Summary">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Summary
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm">{entry.summary}</p>
            </section>
          )}
          {entry.question && (
            <section aria-label="Follow-up">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Follow-up
              </h2>
              <p className="mt-1 text-sm italic text-muted-foreground">
                {entry.question}
              </p>
            </section>
          )}
          {entry.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <li key={t}>
                  <Badge variant="secondary">{t}</Badge>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {entry.contentMarkdown && (
        <Collapsible asChild>
          <section aria-label="Extracted content" className="border-t pt-4">
            <CollapsibleTrigger
              aria-controls={markdownId}
              className="group inline-flex items-center gap-1 text-sm font-medium hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="group-data-[state=open]:hidden">
                Show extracted content
              </span>
              <span className="hidden group-data-[state=open]:inline">
                Hide extracted content
              </span>
              <ChevronDownIcon
                aria-hidden="true"
                className="size-3.5 transition-transform group-data-[state=open]:rotate-180"
              />
            </CollapsibleTrigger>
            <CollapsibleContent id={markdownId}>
              <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded-md border bg-card p-3 text-xs leading-relaxed">
                {entry.contentMarkdown}
              </pre>
            </CollapsibleContent>
          </section>
        </Collapsible>
      )}

      {related.length > 0 && (
        <section aria-label="Related entries" className="border-t pt-4">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Related
          </h2>
          <ul className="mt-2 space-y-2">
            {related.map((item) => (
              <li key={item.id}>
                <RelatedRow item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button
          type="button"
          // Reuses the "New chat" path from ChatListPage: a client-minted
          // conversation id, so no round-trip is needed to start one. `?about`
          // carries the entry through, which — unlike router state — survives a
          // reload and a copied link.
          onClick={() =>
            void navigate(
              `/chat/${crypto.randomUUID()}?about=${encodeURIComponent(entry.id)}`,
            )
          }
          disabled={entry.status !== "ready"}
        >
          Ask about this entry
        </Button>
        <Button
          type="button"
          onClick={() => enroll.mutate()}
          disabled={enroll.isPending}
          title="Turn this entry into a flashcard — Review quizzes you on it at growing intervals so it sticks."
        >
          {enroll.isPending ? "Adding…" : "Add to review"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => reingest.mutate()}
          disabled={reingest.isPending || entry.status === "pending"}
        >
          {reingest.isPending ? "Reingesting…" : "Reingest"}
        </Button>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          trigger={
            <Button type="button" variant="destructive">
              Delete
            </Button>
          }
          title="Delete this entry?"
          description={`"${title}" and its extracted content will be removed permanently. This cannot be undone.`}
          confirmLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </article>
  );
}
