import { Link } from "react-router";
import type { EntryDTO } from "../api";
import { Spinner } from "./Spinner";

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "";
  }
}

export function EntryCard({
  entry,
  onRetry,
  retrying,
}: {
  entry: EntryDTO;
  onRetry?: (id: string) => void;
  retrying?: boolean;
}) {
  const title = entry.title?.trim() || entry.canonicalUrl;
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/entries/${encodeURIComponent(entry.id)}`}
          className="flex-1 text-base font-semibold text-slate-900 hover:underline"
        >
          {title}
        </Link>
        {entry.status === "pending" && <Spinner label="ingesting" />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        {entry.sourceDomain && <span>{entry.sourceDomain}</span>}
        {entry.sourceDomain && <span aria-hidden="true">·</span>}
        <span>{formatDate(entry.createdAt)}</span>
      </div>
      {entry.status === "ready" && entry.takeaway && (
        <p className="mt-3 line-clamp-3 text-sm text-slate-700">{entry.takeaway}</p>
      )}
      {entry.status === "failed" && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
          <p>
            Ingest failed
            {entry.error ? <>: <span className="italic">{entry.error}</span></> : "."}
          </p>
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(entry.id)}
              disabled={retrying}
              className="mt-2 rounded border border-red-300 bg-white px-2 py-1 text-xs font-medium text-red-800 hover:bg-red-100 disabled:opacity-50"
            >
              {retrying ? "Retrying…" : "Retry"}
            </button>
          )}
        </div>
      )}
      {entry.tags.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-1">
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
    </article>
  );
}
