import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useParams } from "react-router";
import { api, type EntryDTO, type EntryListPage } from "../api";
import { EntryListView } from "../components/EntryListView";
import { entriesKey } from "../lib/entry-marks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * One tag's entries, filtered server-side. Same list UI as the feed, and the same
 * default view — archived entries are excluded, which is what makes the count on
 * /tags an honest description of what lands here.
 */
export function TagFeedPage() {
  const params = useParams();
  const tag = params.tag ?? "";

  const listQuery = useInfiniteQuery<
    EntryListPage,
    unknown,
    InfiniteData<EntryListPage>,
    ReturnType<typeof entriesKey>,
    string | null
  >({
    queryKey: entriesKey({ tag }),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.listEntries({ cursor: pageParam, limit: 20, tag, signal }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: tag.length > 0,
  });

  const items: EntryDTO[] = useMemo(() => {
    const seen = new Set<string>();
    const merged: EntryDTO[] = [];
    for (const page of listQuery.data?.pages ?? []) {
      for (const entry of page.items) {
        if (seen.has(entry.id)) continue;
        seen.add(entry.id);
        merged.push(entry);
      }
    }
    return merged;
  }, [listQuery.data]);

  return (
    <div className="space-y-5">
      <div>
        <Link to="/tags" className="text-sm text-muted-foreground hover:underline">
          ← All tags
        </Link>
      </div>

      <header>
        <h1 className="text-2xl font-semibold">
          Tagged <span className="font-mono">{tag}</span>
        </h1>
      </header>

      <EntryListView
        label={`Entries tagged ${tag}`}
        items={items}
        isLoading={listQuery.isLoading}
        isError={listQuery.isError}
        error={listQuery.error}
        onRetryQuery={() => void listQuery.refetch()}
        empty={
          <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
            <p className="font-medium text-foreground">
              Nothing tagged <span className="font-mono">{tag}</span>.
            </p>
            <p className="mt-1">
              Archived entries are not listed here — check the Archived filter on
              your feed.
            </p>
            <Button asChild variant="link" className="mt-2">
              <Link to="/tags">Back to all tags</Link>
            </Button>
          </Card>
        }
        hasNextPage={listQuery.hasNextPage}
        isFetchingNextPage={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
      />
    </div>
  );
}
