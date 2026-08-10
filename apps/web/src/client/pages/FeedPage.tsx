import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ApiError,
  DuplicateUrlError,
  api,
  type EntryDTO,
  type EntryListPage,
} from "../api";
import { EntryCard, EntryCardSkeleton } from "../components/EntryCard";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function FeedPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [addError, setAddError] = useState<unknown>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const listQuery = useInfiniteQuery<EntryListPage, unknown, InfiniteData<EntryListPage>, readonly ["entries"], string | null>({
    queryKey: ["entries"] as const,
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.listEntries({ cursor: pageParam, limit: 20, signal }),
    getNextPageParam: (last) => last.nextCursor,
    enabled: debouncedQuery === "",
  });

  const searchQuery = useQuery({
    queryKey: ["search", debouncedQuery] as const,
    queryFn: ({ signal }) => api.search(debouncedQuery, signal),
    enabled: debouncedQuery.length > 0,
  });

  const createMutation = useMutation({
    mutationFn: (u: string) => api.createEntry(u),
    onSuccess: (data) => {
      setUrl("");
      setAddError(null);
      toast.success("Link saved", {
        description: "Extracting and summarising it now.",
      });
      // Optimistic pending card at the top of the feed.
      const now = Date.now();
      const optimistic: EntryDTO = {
        id: data.id,
        url: url.trim(),
        canonicalUrl: url.trim(),
        title: null,
        sourceDomain: safeHost(url.trim()),
        summary: null,
        takeaway: null,
        question: null,
        tags: [],
        status: data.status,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      qc.setQueryData<{ pages: EntryListPage[]; pageParams: unknown[] } | undefined>(
        ["entries"],
        (prev) => {
          if (!prev) return prev;
          const [firstPage, ...rest] = prev.pages;
          if (!firstPage) return prev;
          const newFirst: EntryListPage = {
            items: [optimistic, ...firstPage.items.filter((i) => i.id !== data.id)],
            nextCursor: firstPage.nextCursor,
          };
          return { ...prev, pages: [newFirst, ...rest] };
        },
      );
      // Reconcile with the server soon.
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => {
      if (e instanceof DuplicateUrlError) {
        toast.info("You already saved that link", {
          description: "Opening the entry you already have.",
        });
        void navigate(`/entries/${encodeURIComponent(e.existingId)}`);
        setUrl("");
        setAddError(null);
        return;
      }
      setAddError(e);
      toast.error("Could not save that link", {
        description: friendlyMessage(e),
      });
    },
  });

  const reingestMutation = useMutation({
    mutationFn: (id: string) => api.reingestEntry(id),
    onSuccess: () => {
      toast.success("Reingesting", { description: "Fetching the link again." });
      void qc.invalidateQueries({ queryKey: ["entries"] });
    },
    onError: (e) => {
      toast.error("Reingest failed", { description: friendlyMessage(e) });
    },
  });

  function onAddSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!trimmed) return;
    setAddError(null);
    createMutation.mutate(trimmed);
  }

  const items: EntryDTO[] = useMemo(() => {
    if (debouncedQuery) return searchQuery.data?.items ?? [];
    const pages = listQuery.data?.pages ?? [];
    const seen = new Set<string>();
    const merged: EntryDTO[] = [];
    for (const p of pages) {
      for (const e of p.items) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          merged.push(e);
        }
      }
    }
    return merged;
  }, [debouncedQuery, searchQuery.data, listQuery.data]);

  const isSearching = debouncedQuery.length > 0;
  const activeQuery = isSearching ? searchQuery : listQuery;
  const showSkeletons = activeQuery.isLoading;

  return (
    <div className="space-y-6">
      <section aria-label="Add a link">
        <form onSubmit={onAddSubmit} className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="til-url" className="sr-only">
            URL
          </label>
          <Input
            id="til-url"
            type="url"
            required
            placeholder="Paste a URL to save…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1"
            disabled={createMutation.isPending}
          />
          <Button type="submit" disabled={createMutation.isPending || !url.trim()}>
            {createMutation.isPending ? "Adding…" : "Add"}
          </Button>
        </form>
        {addError !== null && (
          <p className="mt-2 text-sm text-destructive" role="alert">
            {friendlyMessage(addError)}
          </p>
        )}
      </section>

      <section aria-label="Search">
        <label htmlFor="til-search" className="sr-only">
          Search entries
        </label>
        <Input
          id="til-search"
          type="search"
          placeholder="Search your feed…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </section>

      <section aria-label={isSearching ? "Search results" : "Feed"}>
        {showSkeletons ? (
          <div className="space-y-3">
            <EntryCardSkeleton />
            <EntryCardSkeleton />
            <EntryCardSkeleton />
          </div>
        ) : activeQuery.isError ? (
          <ErrorBanner
            error={activeQuery.error}
            onRetry={() => activeQuery.refetch()}
          />
        ) : items.length === 0 ? (
          <EmptyState searching={isSearching} query={debouncedQuery} />
        ) : (
          <ul className="space-y-3">
            {items.map((e) => (
              <li key={e.id}>
                <EntryCard
                  entry={e}
                  onRetry={(id) => reingestMutation.mutate(id)}
                  retrying={reingestMutation.isPending && reingestMutation.variables === e.id}
                />
              </li>
            ))}
          </ul>
        )}
        {!isSearching && listQuery.hasNextPage && (
          <div className="mt-4 flex justify-center">
            <Button
              type="button"
              variant="outline"
              onClick={() => listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
            >
              {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyState({ searching, query }: { searching: boolean; query: string }) {
  if (searching) {
    return (
      <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
        <p>
          No matches for <span className="font-medium">"{query}"</span>.
        </p>
      </Card>
    );
  }
  return (
    <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
      <p className="font-medium text-foreground">Your feed is empty.</p>
      <p className="mt-1">Paste a link above to save your first learning.</p>
    </Card>
  );
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).host || null;
  } catch {
    return null;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
