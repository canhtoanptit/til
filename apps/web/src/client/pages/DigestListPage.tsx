import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "../api";
import { DigestCard, DigestCardSkeleton } from "../components/DigestCard";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";

export function DigestListPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const listQuery = useQuery({
    queryKey: ["digests"] as const,
    queryFn: ({ signal }) => api.listDigests({ limit: 20, signal }),
    refetchInterval: (q) =>
      q.state.data?.items.some((d) => d.status === "pending") ? 2000 : false,
  });

  const run = useMutation({
    mutationFn: () => api.runDigest(),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["digests"] });
      navigate(`/digests/${encodeURIComponent(data.id)}`);
    },
  });

  const items = listQuery.data?.items ?? [];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Digests</h1>
          <p className="mt-1 text-sm text-slate-600">
            A weekly roundup of interesting things from Hacker News, Lobsters, arXiv
            and your RSS feeds.
          </p>
        </div>
        <button
          type="button"
          onClick={() => run.mutate()}
          disabled={run.isPending}
          className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {run.isPending ? "Starting…" : "Run now"}
        </button>
      </header>

      {run.isError && (
        <p className="text-sm text-red-700" role="alert">
          {friendlyMessage(run.error)}
        </p>
      )}

      <section aria-label="Digest runs">
        {listQuery.isLoading ? (
          <div className="space-y-3">
            <DigestCardSkeleton />
            <DigestCardSkeleton />
            <DigestCardSkeleton />
          </div>
        ) : listQuery.isError ? (
          <ErrorBanner error={listQuery.error} onRetry={() => listQuery.refetch()} />
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
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      <p className="font-medium text-slate-700">No digests yet.</p>
      <p className="mt-1">
        A digest is generated automatically once a week. You can also start one at
        any time with <span className="font-medium">Run now</span> — it takes a
        minute or two to gather and rank candidates.
      </p>
    </div>
  );
}
