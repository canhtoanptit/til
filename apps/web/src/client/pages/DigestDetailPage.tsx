import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api, type DigestItemDTO } from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import {
  digestHeading,
  formatItemCount,
  formatRunDateTime,
  formatScore,
  formatWindowRange,
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
      void qc.invalidateQueries({ queryKey: ["digests"] });
      navigate(`/digests/${encodeURIComponent(data.id)}`);
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteDigest(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["digests"] });
      navigate("/digests");
    },
  });

  if (query.isLoading) {
    return <Spinner label="Loading digest…" />;
  }

  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="rounded border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm text-slate-600">This digest doesn't exist.</p>
          <Link
            to="/digests"
            className="mt-3 inline-block text-sm font-medium text-slate-900 underline"
          >
            Back to digests
          </Link>
        </div>
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
        <Link to="/digests" className="text-sm text-slate-500 hover:underline">
          ← Back
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">
          {digestHeading(digest)}
        </h1>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
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
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p className="font-medium">This digest run failed.</p>
          {digest.error && <p className="mt-1 italic">{digest.error}</p>}
          <button
            type="button"
            onClick={() => rerun.mutate()}
            disabled={rerun.isPending}
            className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
          >
            {rerun.isPending ? "Starting…" : "Run again"}
          </button>
        </div>
      )}

      {digest.status === "pending" && (
        <div
          role="status"
          className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-600"
        >
          <Spinner label="Gathering candidates and writing the digest — this page updates itself…" />
        </div>
      )}

      {digest.status === "ready" && digest.intro && (
        <section aria-label="Intro">
          <p className="whitespace-pre-wrap text-base text-slate-800">
            {digest.intro}
          </p>
        </section>
      )}

      {digest.items.length > 0 && (
        <section aria-label="Digest items">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
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
        <p className="rounded border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          This run finished without finding anything worth including.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <button
          type="button"
          onClick={() => rerun.mutate()}
          disabled={rerun.isPending || digest.status === "pending"}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-50"
        >
          {rerun.isPending ? "Starting…" : "Run again"}
        </button>
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            className="rounded border border-red-300 bg-white px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-slate-700">Are you sure?</span>
            <button
              type="button"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
              className="rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {remove.isPending ? "Deleting…" : "Delete permanently"}
            </button>
            <button
              type="button"
              onClick={() => setConfirmDelete(false)}
              className="rounded px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        )}
        {rerun.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(rerun.error)}</p>
        )}
        {remove.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(remove.error)}</p>
        )}
      </div>
    </article>
  );
}

function DigestItem({ item }: { item: DigestItemDTO }) {
  const score = formatScore(item.score);
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600"
        >
          {item.rank}
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-slate-900">
            <a
              href={item.url}
              target="_blank"
              rel="noreferrer noopener"
              className="hover:underline"
            >
              {item.title}
            </a>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            <span
              title={item.sourceName}
              className="rounded-full bg-slate-100 px-2 py-0.5 text-slate-600"
            >
              {sourceLabel(item.sourceName)}
            </span>
            {item.sourceDomain && <span>{item.sourceDomain}</span>}
            {score !== null && (
              <>
                <span aria-hidden="true">·</span>
                <span title="ranking score" className="text-slate-400">
                  score {score}
                </span>
              </>
            )}
          </div>
          {item.why && (
            <p className="mt-3 border-l-4 border-emerald-500 bg-emerald-50/70 py-2 pl-3 text-sm text-slate-900">
              {item.why}
            </p>
          )}
          {item.evidence.length > 0 && (
            <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
              <span>also on</span>
              {item.evidence.map((ev) => (
                <a
                  key={`${ev.sourceName}-${ev.url}`}
                  href={ev.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={ev.title}
                  className="underline hover:text-slate-700"
                >
                  {sourceLabel(ev.sourceName)}
                </a>
              ))}
            </p>
          )}
        </div>
      </div>
    </article>
  );
}
