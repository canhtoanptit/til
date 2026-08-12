import type { ReactNode } from "react";
import type { EntryDTO } from "../api";
import { EntryCard, EntryCardSkeleton } from "./EntryCard";
import { ErrorBanner } from "./ErrorBanner";
import { favoriteVars } from "../lib/entry-marks";
import { useEntryPatch } from "../lib/use-entry-patch";
import { Button } from "@/components/ui/button";

/**
 * The list half of a feed: skeletons, error, empty state, cards, "Load more".
 * Extracted so the feed, each filter chip and every tag page render the identical
 * thing, with each page owning its own query (the feed's optimistic add writes into
 * its own cache key, which a shared query hook would have hidden).
 *
 * The star lives here rather than in each page, because "favorite an entry from a
 * list" is one behaviour no matter which list it is.
 */
export function EntryListView({
  label,
  items,
  isLoading,
  isError,
  error,
  onRetryQuery,
  empty,
  hasNextPage = false,
  isFetchingNextPage = false,
  onLoadMore,
  onReingest,
  reingestingId,
}: {
  label: string;
  items: EntryDTO[];
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetryQuery: () => void;
  empty: ReactNode;
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  onReingest?: (id: string) => void;
  reingestingId?: string | null;
}) {
  const patch = useEntryPatch();

  return (
    <section aria-label={label}>
      {isLoading ? (
        <div className="space-y-3">
          <EntryCardSkeleton />
          <EntryCardSkeleton />
          <EntryCardSkeleton />
        </div>
      ) : isError ? (
        <ErrorBanner error={error} onRetry={onRetryQuery} />
      ) : items.length === 0 ? (
        empty
      ) : (
        <ul className="space-y-3">
          {items.map((entry) => (
            <li key={entry.id}>
              <EntryCard
                entry={entry}
                {...(onReingest ? { onRetry: onReingest } : {})}
                retrying={reingestingId === entry.id}
                onToggleFavorite={(e) =>
                  patch.mutate(favoriteVars(e.id, !e.favorite))
                }
                favoritePending={
                  patch.isPending && patch.variables?.id === entry.id
                }
              />
            </li>
          ))}
        </ul>
      )}
      {hasNextPage && onLoadMore && (
        <div className="mt-4 flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={onLoadMore}
            disabled={isFetchingNextPage}
          >
            {isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      )}
    </section>
  );
}
