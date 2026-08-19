import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { api, type DigestKind } from "../api";
import { DigestCard, DigestCardSkeleton } from "../components/DigestCard";
import { digestRunCopy } from "../components/digest-format";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export function DigestListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["digests"] as const,
    queryFn: ({ signal }) => api.listDigests({ limit: 20, signal }),
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.status === "pending") ? 2000 : false,
  });

  // One mutation for both buttons, keyed by kind: the pending lock is then shared
  // by construction, so a second click cannot start a run while one is in flight
  // — and `run.variables` still says which button the reader pressed.
  const run = useMutation({
    mutationFn: (kind: DigestKind) => api.runDigest({ kind }),
    onSuccess: (data, kind) => {
      const copy = digestRunCopy(kind);
      toast.success(copy.startedTitle, {
        description: copy.startedDescription,
      });
      void qc.invalidateQueries({ queryKey: ["digests"] });
      void navigate(`/digests/${encodeURIComponent(data.id)}`);
    },
    onError: (e, kind) => {
      toast.error(digestRunCopy(kind).failedTitle, {
        description: friendlyMessage(e),
      });
    },
  });

  const runningKind = run.isPending ? run.variables : null;
  const items = listQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Digests</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A weekly roundup of interesting things from Hacker News, Lobsters,
            arXiv and your RSS feeds — plus a monthly report that reads back
            over what you saved.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={() => run.mutate("weekly")}
            disabled={run.isPending}
          >
            {runningKind === "weekly" ? "Starting…" : "Run now"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => run.mutate("monthly-report")}
            disabled={run.isPending}
          >
            {runningKind === "monthly-report"
              ? "Starting…"
              : "Run monthly report"}
          </Button>
        </div>
      </header>

      <section aria-label="Digest runs">
        {listQuery.isLoading ? (
          <div className="space-y-3">
            <DigestCardSkeleton />
            <DigestCardSkeleton />
            <DigestCardSkeleton />
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
            {items.map((d) => (
              <li key={d.id}>
                <DigestCard digest={d} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function EmptyState() {
  return (
    <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
      <p className="font-medium text-foreground">No digests yet.</p>
      <p className="mt-1">
        A digest is generated automatically once a week. You can also start one
        at any time with <span className="font-medium">Run now</span> — it takes
        a minute or two to gather and rank candidates.
      </p>
    </Card>
  );
}
