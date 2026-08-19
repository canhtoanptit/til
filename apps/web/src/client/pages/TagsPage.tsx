import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api } from "../api";
import { ErrorBanner } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { TAGS_KEY } from "../lib/entry-marks";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

/**
 * Every tag in the library, most-used first. The counts come from one aggregate
 * endpoint and exclude archived entries, so the number next to a tag is exactly how
 * many entries the link behind it will list.
 */
export function TagsPage() {
  const query = useQuery({
    queryKey: TAGS_KEY,
    queryFn: ({ signal }) => api.listTags(signal),
  });

  const tags = query.data?.items ?? [];

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Tags</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every tag your saved reading has been given, most used first.
        </p>
      </header>

      {query.isLoading ? (
        <Spinner label="Loading tags…" />
      ) : query.isError ? (
        <ErrorBanner error={query.error} onRetry={() => void query.refetch()} />
      ) : tags.length === 0 ? (
        <Card className="gap-0 border-dashed bg-transparent p-8 text-center text-sm text-muted-foreground shadow-none">
          <p className="font-medium text-foreground">No tags yet.</p>
          <p className="mt-1">
            Tags are written when an entry is summarised — save a link to get
            some.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label="All tags">
          {tags.map(({ tag, count }) => (
            <li key={tag}>
              <Badge
                asChild
                variant="outline"
                className="gap-1.5 px-2.5 py-1 text-sm"
              >
                <Link to={`/tags/${encodeURIComponent(tag)}`}>
                  {tag}
                  <span className="text-muted-foreground" aria-hidden="true">
                    {count}
                  </span>
                  <span className="sr-only">{`${count} entries`}</span>
                </Link>
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
