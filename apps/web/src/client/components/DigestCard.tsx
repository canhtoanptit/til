import { Link } from "react-router";
import type { DigestSummaryDTO } from "../api";
import { Skeleton } from "./Skeleton";
import { Spinner } from "./Spinner";
import { digestHeading, formatItemCount, formatRunDate } from "./digest-format";

export function DigestCard({ digest }: { digest: DigestSummaryDTO }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/digests/${encodeURIComponent(digest.id)}`}
          className="flex-1 text-base font-semibold text-slate-900 hover:underline"
        >
          {digestHeading(digest)}
        </Link>
        {digest.status === "pending" && <Spinner label="running" />}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
        <span>{formatRunDate(digest.runAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatItemCount(digest.itemCount)}</span>
        <span aria-hidden="true">·</span>
        <span>last {digest.windowDays} days</span>
      </div>
      {digest.status === "ready" && digest.intro && (
        <p className="mt-3 line-clamp-2 text-sm text-slate-700">{digest.intro}</p>
      )}
      {digest.status === "failed" && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-800">
          <p>
            Digest run failed
            {digest.error ? (
              <>
                : <span className="italic">{digest.error}</span>
              </>
            ) : (
              "."
            )}
          </p>
        </div>
      )}
    </article>
  );
}

export function DigestCardSkeleton() {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-2 h-3 w-2/5" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-4/6" />
    </article>
  );
}
