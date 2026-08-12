import { Link } from "react-router";
import type { DigestSummaryDTO } from "../api";
import { DigestKindBadge } from "./DigestKindBadge";
import { Spinner } from "./Spinner";
import { digestHeading, formatItemCount, formatRunDate } from "./digest-format";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

export function DigestCard({ digest }: { digest: DigestSummaryDTO }) {
  return (
    <Card asChild className="gap-0 p-4 transition-shadow hover:shadow-md">
      <article>
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`/digests/${encodeURIComponent(digest.id)}`}
            className="flex-1 text-base font-semibold hover:underline"
          >
            {digestHeading(digest)}
          </Link>
          {digest.status === "pending" && <Spinner label="running" />}
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <DigestKindBadge kind={digest.kind} />
          <span>{formatRunDate(digest.runAt)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatItemCount(digest.itemCount)}</span>
          <span aria-hidden="true">·</span>
          <span>last {digest.windowDays} days</span>
        </div>
        {digest.status === "ready" && digest.intro && (
          <p className="mt-3 line-clamp-2 text-sm text-muted-foreground">
            {digest.intro}
          </p>
        )}
        {digest.status === "failed" && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
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
    </Card>
  );
}

export function DigestCardSkeleton() {
  return (
    <Card aria-hidden="true" className="gap-0 p-4">
      <Skeleton className="h-4 w-1/2" />
      <Skeleton className="mt-2 h-3 w-2/5" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-4/6" />
    </Card>
  );
}
