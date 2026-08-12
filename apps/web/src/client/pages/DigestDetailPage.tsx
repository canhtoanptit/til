import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { ApiError, api, type DigestItemDTO } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  digestHeading,
  formatItemCount,
  formatRunDateTime,
  formatScore,
  formatWindowRange,
  matchesYourReading,
  sourceLabel,
} from "../components/digest-format";

export function DigestDetailPage() {
  const params = useParams();
  const id = params.id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const query = useQuery({
    queryKey: ["digest", id] as const,
    queryFn: ({ signal }) => api.getDigest(id, signal),
    refetchInterval: (q) => (q.state.data?.status === "pending" ? 2000 : false),
    enabled: id.length > 0,
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  const rerun = useMutation({
    mutationFn: () => api.runDigest(),
    onSuccess: (data) => {
      toast.success("Digest run started", {
        description: "Gathering and ranking candidates — this takes a minute or two.",
      });
      void qc.invalidateQueries({ queryKey: ["digests"] });
      void navigate(`/digests/${encodeURIComponent(data.id)}`);
    },
    onError: (e) => {
      toast.error("Could not start a digest run", {
        description: friendlyMessage(e),
      });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDigest(id),
    onSuccess: () => {
      setConfirmDelete(false);
      toast.success("Digest deleted");
      void qc.invalidateQueries({ queryKey: ["digests"] });
      void navigate("/digests");
    },
    onError: (e) => {
      setConfirmDelete(false);
      toast.error("Could not delete that digest", {
        description: friendlyMessage(e),
      });
    },
  });

  if (query.isLoading) {
    return <Spinner label="Loading digest…" />;
  }

  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <Card className="gap-0 p-6 text-center">
          <p className="text-sm text-muted-foreground">This digest doesn't exist.</p>
          <Button asChild variant="link" className="mt-3">
            <Link to="/digests">Back to digests</Link>
          </Button>
        </Card>
      );
    }
    return <ErrorBanner error={err} onRetry={() => query.refetch()} />;
  }

  const digest = query.data;
  if (!digest) return null;

  const range = formatWindowRange(digest.runAt, digest.windowDays);

  return (
    <article className="space-y-5">
      <div>
        <Link to="/digests" className="text-sm text-muted-foreground hover:underline">
          ← Back
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">{digestHeading(digest)}</h1>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
          <span>{formatRunDateTime(digest.runAt)}</span>
          <span aria-hidden="true">·</span>
          <span>last {digest.windowDays} days{range ? ` (${range})` : ""}</span>
          <span aria-hidden="true">·</span>
          <span>{formatItemCount(digest.itemCount)}</span>
          {digest.status === "pending" && (
            <>
              <span aria-hidden="true">·</span>
              <Spinner label="running…" />
            </>
          )}
        </div>
      </header>

      {digest.status === "failed" && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <p className="font-medium">This digest run failed.</p>
          {digest.error && <p className="mt-1 italic">{digest.error}</p>}
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="mt-2"
            onClick={() => rerun.mutate()}
            disabled={rerun.isPending}
          >
            {rerun.isPending ? "Starting…" : "Run again"}
          </Button>
        </div>
      )}

      {digest.status === "pending" && (
        <Card role="status" className="gap-0 p-3">
          <Spinner label="Gathering candidates and writing the digest — this page updates itself…" />
        </Card>
      )}

      {digest.status === "ready" && digest.intro && (
        <section aria-label="Intro">
          <p className="whitespace-pre-wrap text-base">{digest.intro}</p>
        </section>
      )}

      {digest.items.length > 0 && (
        <section aria-label="Digest items">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Items
          </h2>
          <ol className="mt-3 space-y-3">
            {digest.items.map((item) => (
              <li key={`${item.rank}-${item.url}`}>
                <DigestItem item={item} />
              </li>
            ))}
          </ol>
        </section>
      )}

      {digest.status === "ready" && digest.items.length === 0 && (
        <Card className="gap-0 border-dashed bg-transparent p-6 text-center text-sm text-muted-foreground shadow-none">
          <p>This run finished without finding anything worth including.</p>
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || digest.status === "pending"}
        >
          {rerun.isPending ? "Starting…" : "Run again"}
        </Button>
        <ConfirmDialog
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          trigger={
            <Button type="button" variant="destructive">
              Delete
            </Button>
          }
          title="Delete this digest?"
          description={`"${digestHeading(digest)}" and all of its ranked items will be removed permanently. This cannot be undone.`}
          confirmLabel="Delete permanently"
          pendingLabel="Deleting…"
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
    </article>
  );
}

function DigestItem({ item }: { item: DigestItemDTO }) {
  const score = formatScore(item.score);
  const matched = matchesYourReading(item.score, item.interestScore);
  const interest =
    item.interestScore === null ? null : formatScore(item.interestScore);
  return (
    <Card asChild className="gap-0 p-4 transition-shadow hover:shadow-md">
      <article>
        <div className="flex items-start gap-3">
          <span
            aria-hidden="true"
            className="mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
          >
            {item.rank}
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-semibold">
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="hover:underline"
              >
                {item.title}
              </a>
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
              <Badge variant="secondary" title={item.sourceName}>
                {sourceLabel(item.sourceName)}
              </Badge>
              {item.sourceDomain && <span>{item.sourceDomain}</span>}
              {score !== null && (
                <>
                  <span aria-hidden="true">·</span>
                  <span title="ranking score" className="opacity-70">
                    score {score}
                  </span>
                </>
              )}
              {matched && (
                <Badge
                  variant="outline"
                  className="border-success/40 bg-success/10 font-normal text-success"
                  title={`This ranked up because it resembles your saved reading${interest === null ? "" : ` (similarity ${interest})`}.`}
                >
                  <SparklesIcon aria-hidden="true" />
                  matches your reading
                </Badge>
              )}
            </div>
            {item.why && (
              <p className="mt-3 border-l-4 border-success bg-success/10 py-2 pl-3 text-sm">
                {item.why}
              </p>
            )}
            {item.evidence.length > 0 && (
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span>also on</span>
                {item.evidence.map((ev) => (
                  <a
                    key={`${ev.sourceName}-${ev.url}`}
                    href={ev.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    title={ev.title}
                    className="underline hover:text-foreground"
                  >
                    {sourceLabel(ev.sourceName)}
                  </a>
                ))}
              </p>
            )}
          </div>
        </div>
      </article>
    </Card>
  );
}
