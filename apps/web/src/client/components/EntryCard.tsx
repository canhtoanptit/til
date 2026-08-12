import { Link } from "react-router";
import { FileTextIcon, StarIcon, VideoIcon } from "lucide-react";
import type { ContentType, EntryDTO } from "../api";
import { contentTypeBadge } from "../lib/content-type";
import { Spinner } from "./Spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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
  onToggleFavorite,
  favoritePending,
}: {
  entry: EntryDTO;
  onRetry?: (id: string) => void;
  retrying?: boolean;
  /** Omit to render the card without a star — search results and any read-only list. */
  onToggleFavorite?: (entry: EntryDTO) => void;
  favoritePending?: boolean;
}) {
  const title = entry.title?.trim() || entry.canonicalUrl;
  return (
    <Card asChild className="gap-0 p-4 transition-shadow hover:shadow-md">
      <article>
        <div className="flex items-start justify-between gap-3">
          <Link
            to={`/entries/${encodeURIComponent(entry.id)}`}
            className="flex-1 text-base font-semibold hover:underline"
          >
            {title}
          </Link>
          {entry.status === "pending" && <Spinner label="ingesting" />}
          {onToggleFavorite && (
            <FavoriteButton
              entry={entry}
              onToggle={onToggleFavorite}
              pending={favoritePending}
            />
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {entry.sourceDomain && <span>{entry.sourceDomain}</span>}
          {entry.sourceDomain && <span aria-hidden="true">·</span>}
          <span>{formatDate(entry.createdAt)}</span>
          <ContentTypeBadge contentType={entry.contentType} />
        </div>
        {entry.status === "ready" && entry.takeaway && (
          <p className="mt-3 line-clamp-3 text-sm text-muted-foreground">
            {entry.takeaway}
          </p>
        )}
        {entry.status === "failed" && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 p-2 text-sm text-destructive">
            <p>
              Ingest failed
              {entry.error ? (
                <>
                  : <span className="italic">{entry.error}</span>
                </>
              ) : (
                "."
              )}
            </p>
            {onRetry && (
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-2"
                onClick={() => onRetry(entry.id)}
                disabled={retrying}
              >
                {retrying ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>
        )}
        {entry.tags.length > 0 && (
          <ul className="mt-3 flex flex-wrap gap-1">
            {entry.tags.map((t) => (
              <li key={t}>
                <TagLink tag={t} />
              </li>
            ))}
          </ul>
        )}
      </article>
    </Card>
  );
}

/**
 * Marks the entries that are not web pages (P25). Renders nothing for an article,
 * which is the default and the majority — the point of the badge is that it is
 * unusual. `variant="outline"` deliberately: it is built from the `border`/
 * `foreground` tokens, so it reads the same subtle way in both themes without a
 * colour of its own, and never competes with a tag pill.
 *
 * Shared by the card and the detail page so the two cannot drift.
 */
export function ContentTypeBadge({ contentType }: { contentType: ContentType }) {
  const badge = contentTypeBadge(contentType);
  if (!badge) return null;
  const Icon = contentType === "video" ? VideoIcon : FileTextIcon;
  return (
    <>
      <span aria-hidden="true">·</span>
      <Badge variant="outline" title={badge.hint} className="font-normal">
        <Icon aria-hidden="true" />
        {badge.label}
      </Badge>
    </>
  );
}

/**
 * A tag as a way in, not decoration. Shared with the detail page so both spell the
 * route the same way — `encodeURIComponent` matters because a tag is user-ish data
 * (an LLM writes it) and reaches the server as a query param.
 */
export function TagLink({ tag }: { tag: string }) {
  return (
    <Badge asChild variant="secondary">
      <Link to={`/tags/${encodeURIComponent(tag)}`} title={`Entries tagged ${tag}`}>
        {tag}
      </Link>
    </Badge>
  );
}

/**
 * Toggle, not a command: `aria-pressed` is what tells a screen reader whether the
 * entry is already a favorite, since the icon fill alone carries that for everyone
 * else. Sits inside a link-bearing card, so it stops propagation-free by being a
 * sibling of the title link rather than nested inside it.
 */
export function FavoriteButton({
  entry,
  onToggle,
  pending = false,
  size = "icon-sm",
}: {
  entry: EntryDTO;
  onToggle: (entry: EntryDTO) => void;
  pending?: boolean;
  size?: "icon-sm" | "icon";
}) {
  const label = entry.favorite ? "Remove from favorites" : "Add to favorites";
  return (
    <Button
      type="button"
      variant="ghost"
      size={size}
      aria-pressed={entry.favorite}
      aria-label={label}
      title={label}
      disabled={pending}
      onClick={() => onToggle(entry)}
    >
      <StarIcon
        aria-hidden="true"
        className={cn(
          entry.favorite ? "fill-warning text-warning" : "text-muted-foreground",
        )}
      />
    </Button>
  );
}

export function EntryCardSkeleton() {
  return (
    <Card aria-hidden="true" className="gap-0 p-4">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-2 h-3 w-1/3" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-5/6" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-4 w-12 rounded-full" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
    </Card>
  );
}
