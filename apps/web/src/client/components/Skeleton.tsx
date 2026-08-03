export function Skeleton({ className = "" }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse rounded bg-slate-200/70 ${className}`}
    />
  );
}

export function EntryCardSkeleton() {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="mt-2 h-3 w-1/3" />
      <Skeleton className="mt-4 h-3 w-full" />
      <Skeleton className="mt-2 h-3 w-5/6" />
      <div className="mt-3 flex gap-2">
        <Skeleton className="h-4 w-12 rounded-full" />
        <Skeleton className="h-4 w-16 rounded-full" />
      </div>
    </article>
  );
}
