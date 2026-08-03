import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiError, api } from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";

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

export function EntryDetailPage() {
  const params = useParams();
  const id = params.id ?? "";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [showMarkdown, setShowMarkdown] = useState(false);
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

  const reingest = useMutation({
    mutationFn: () => api.reingestEntry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["entry", id] });
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => api.deleteEntry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["entries"] });
      navigate("/");
    },
  });

  if (query.isLoading) {
    return <Spinner label="Loading entry…" />;
  }

  if (query.isError) {
    const err = query.error;
    if (err instanceof ApiError && err.status === 404) {
      return (
        <div className="rounded border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm text-slate-600">This entry doesn't exist.</p>
          <Link
            to="/"
            className="mt-3 inline-block text-sm font-medium text-slate-900 underline"
          >
            Back to feed
          </Link>
        </div>
      );
    }
    return <ErrorBanner error={err} onRetry={() => query.refetch()} />;
  }

  const entry = query.data;
  if (!entry) return null;

  const title = entry.title?.trim() || entry.canonicalUrl;

  return (
    <article className="space-y-5">
      <div>
        <Link to="/" className="text-sm text-slate-500 hover:underline">
          ← Back
        </Link>
      </div>

      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-slate-900">
          <a
            href={entry.url}
            target="_blank"
            rel="noreferrer noopener"
            className="hover:underline"
          >
            {title}
          </a>
        </h1>
        <div className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
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
          className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
        >
          <p className="font-medium">Ingest failed.</p>
          {entry.error && <p className="mt-1 italic">{entry.error}</p>}
          <button
            type="button"
            onClick={() => reingest.mutate()}
            disabled={reingest.isPending}
            className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
          >
            {reingest.isPending ? "Reingesting…" : "Reingest"}
          </button>
        </div>
      )}

      {entry.status === "pending" && (
        <div
          role="status"
          className="rounded-md border border-slate-200 bg-white p-3 text-sm text-slate-600"
        >
          <Spinner label="Waiting for the LLM to finish processing this link…" />
        </div>
      )}

      {entry.status === "ready" && (
        <>
          {entry.takeaway && (
            <section
              aria-label="Takeaway"
              className="rounded-md border-l-4 border-emerald-500 bg-emerald-50/70 p-4"
            >
              <h2 className="text-xs font-semibold uppercase tracking-wide text-emerald-800">
                Takeaway
              </h2>
              <p className="mt-1 text-base text-slate-900">{entry.takeaway}</p>
            </section>
          )}
          {entry.summary && (
            <section aria-label="Summary">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Summary
              </h2>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">
                {entry.summary}
              </p>
            </section>
          )}
          {entry.question && (
            <section aria-label="Follow-up">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Follow-up
              </h2>
              <p className="mt-1 text-sm italic text-slate-700">{entry.question}</p>
            </section>
          )}
          {entry.tags.length > 0 && (
            <ul className="flex flex-wrap gap-1">
              {entry.tags.map((t) => (
                <li
                  key={t}
                  className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                >
                  {t}
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {entry.contentMarkdown && (
        <section aria-label="Extracted content" className="border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={() => setShowMarkdown((s) => !s)}
            aria-expanded={showMarkdown}
            className="text-sm font-medium text-slate-700 hover:underline"
          >
            {showMarkdown ? "Hide" : "Show"} extracted content
          </button>
          {showMarkdown && (
            <pre className="mt-3 max-h-[60vh] overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 text-xs leading-relaxed text-slate-800">
              {entry.contentMarkdown}
            </pre>
          )}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <button
          type="button"
          onClick={() => reingest.mutate()}
          disabled={reingest.isPending || entry.status === "pending"}
          className="rounded border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-800 hover:bg-slate-100 disabled:opacity-50"
        >
          {reingest.isPending ? "Reingesting…" : "Reingest"}
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
        {reingest.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(reingest.error)}</p>
        )}
        {remove.isError && (
          <p className="text-sm text-red-700">{friendlyMessage(remove.error)}</p>
        )}
      </div>
    </article>
  );
}
