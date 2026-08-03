import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import {
  ApiError,
  DuplicateUrlError,
  api,
  type EntryDTO,
  type EntryListPage,
} from "../api";
import { EntryCard } from "../components/EntryCard";
import { EntryCardSkeleton } from "../components/Skeleton";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";

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
        navigate(`/entries/${encodeURIComponent(e.existingId)}`);
        setUrl("");
        setAddError(null);
        return;
      }
      setAddError(e);
    },
  });

  const reingestMutation = useMutation({
    mutationFn: (id: string) => api.reingestEntry(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["entries"] });
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
          <input
            id="til-url"
            type="url"
            required
            placeholder="Paste a URL to save…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            className="flex-1 rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
            disabled={createMutation.isPending}
          />
          <button
            type="submit"
            disabled={createMutation.isPending || !url.trim()}
            className="rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {createMutation.isPending ? "Adding…" : "Add"}
          </button>
        </form>
        {addError !== null && (
          <p className="mt-2 text-sm text-red-700" role="alert">
            {friendlyMessage(addError)}
          </p>
        )}
      </section>

      <section aria-label="Search">
        <label htmlFor="til-search" className="sr-only">
          Search entries
        </label>
        <input
          id="til-search"
          type="search"
          placeholder="Search your feed…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
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
            <button
              type="button"
              onClick={() => listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
              className="rounded border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
            >
              {listQuery.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function EmptyState({ searching, query }: { searching: boolean; query: string }) {
  if (searching) {
    return (
      <p className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
        No matches for <span className="font-medium">"{query}"</span>.
      </p>
    );
  }
  return (
    <div className="rounded border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
      <p className="font-medium text-slate-700">Your feed is empty.</p>
      <p className="mt-1">Paste a link above to save your first learning.</p>
    </div>
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
