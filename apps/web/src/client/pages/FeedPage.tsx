import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";
import {
  ApiError,
  DuplicateUrlError,
  api,
  type EntryDTO,
  type EntryFilter,
  type EntryListPage,
} from "../api";
import { EntryListView } from "../components/EntryListView";
import { friendlyMessage } from "../components/ErrorBanner";
import { readAddParam } from "../lib/bookmarklet";
import { entriesKey } from "../lib/entry-marks";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const FILTERS: { value: EntryFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "favorites", label: "Favorites" },
  { value: "archived", label: "Archived" },
];

export function FeedPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // The `?add=` value already captured this mount, so a re-render cannot double-post.
  const consumedAdd = useRef<string | null>(null);
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [addError, setAddError] = useState<unknown>(null);
  const [filter, setFilter] = useState<EntryFilter>("all");

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  const listQuery = useInfiniteQuery<
    EntryListPage,
    unknown,
    InfiniteData<EntryListPage>,
    ReturnType<typeof entriesKey>,
    string | null
  >({
    // Each chip is its own cursor sequence, so each gets its own cache entry
    // rather than one key whose pages would interleave two different filters.
    queryKey: entriesKey({ filter }),
    initialPageParam: null,
    queryFn: ({ pageParam, signal }) =>
      api.listEntries({ cursor: pageParam, limit: 20, filter, signal }),
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
    // WHY `variables` and not the `url` state: the bookmarklet path submits a url
    // straight from `?add=`, so the state may not have been committed yet — and
    // reading it here would put the wrong link on the optimistic card.
    onSuccess: (data, submitted) => {
      setUrl("");
      setAddError(null);
      toast.success("Link saved", {
        description: "Extracting and summarising it now.",
      });
      // Optimistic pending card at the top of the feed.
      const now = Date.now();
      const optimistic: EntryDTO = {
        id: data.id,
        url: submitted,
        canonicalUrl: submitted,
        title: null,
        sourceDomain: safeHost(submitted),
        summary: null,
        takeaway: null,
        question: null,
        tags: [],
        favorite: false,
        archived: false,
        note: null,
        status: data.status,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      // Always the default view, whichever chip is showing: a link just saved is
      // neither a favorite nor archived, so "all" is the only list it belongs in.
      qc.setQueryData<{ pages: EntryListPage[]; pageParams: unknown[] } | undefined>(
        entriesKey({ filter: "all" }),
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

  // The bookmarklet lands here as `/?add={url}` (C16). The token gate already
  // fronts the app, so arriving with the param is enough to capture the link.
  useEffect(() => {
    const add = readAddParam(searchParams.toString());
    if (add === null) return;
    if (consumedAdd.current === add.url) return;
    consumedAdd.current = add.url;

    // Strip the param before the request settles, so a reload — or the back
    // button — cannot re-ingest the same link.
    const next = new URLSearchParams(searchParams);
    next.delete("add");
    void setSearchParams(next, { replace: true });

    setUrl(add.url);
    if (!add.autoSubmit) {
      toast.info("Check this link before saving", {
        description: "It does not look like an http(s) URL.",
      });
      return;
    }
    setAddError(null);
    createMutation.mutate(add.url);
    // Intentionally keyed on searchParams alone: `createMutation` is a fresh
    // object every render, and the ref above is what makes this fire once.
  }, [searchParams]);

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

      {/* Hidden while searching rather than disabled: search spans the whole
          library, so a lit-up chip next to those results would be a lie. */}
      {!isSearching && (
        <div
          role="group"
          aria-label="Filter entries"
          className="flex flex-wrap gap-2"
        >
          {FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={filter === value ? "default" : "outline"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}
            </Button>
          ))}
        </div>
      )}

      <EntryListView
        label={isSearching ? "Search results" : "Feed"}
        items={items}
        isLoading={showSkeletons}
        isError={activeQuery.isError}
        error={activeQuery.error}
        onRetryQuery={() => void activeQuery.refetch()}
        empty={
          <EmptyState
            searching={isSearching}
            query={debouncedQuery}
            filter={filter}
          />
        }
        hasNextPage={!isSearching && listQuery.hasNextPage}
        isFetchingNextPage={listQuery.isFetchingNextPage}
        onLoadMore={() => void listQuery.fetchNextPage()}
        onReingest={(id) => reingestMutation.mutate(id)}
        reingestingId={
          reingestMutation.isPending ? (reingestMutation.variables ?? null) : null
        }
      />
    </div>
  );
}

function EmptyState({
  searching,
  query,
  filter,
}: {
  searching: boolean;
  query: string;
  filter: EntryFilter;
}) {
  if (searching) {
    return (
      <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
        <p>
          No matches for <span className="font-medium">"{query}"</span>.
        </p>
      </Card>
    );
  }
  if (filter === "favorites") {
    return (
      <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
        <p className="font-medium text-foreground">No favorites yet.</p>
        <p className="mt-1">Star an entry to keep it close at hand.</p>
      </Card>
    );
  }
  if (filter === "archived") {
    return (
      <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
        <p className="font-medium text-foreground">Nothing archived.</p>
        <p className="mt-1">
          Archiving an entry hides it from your feed without deleting it.
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
