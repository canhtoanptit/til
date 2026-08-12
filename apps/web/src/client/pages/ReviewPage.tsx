import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  api,
  type ReviewGrade,
  type ReviewQueueItemDTO,
  type ReviewQueueResponse,
  type ReviewScheduleDTO,
} from "../api";
import { ErrorBanner, friendlyMessage } from "../components/ErrorBanner";
import { Spinner } from "../components/Spinner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/** Prefix shared with the nav badge, so one grade refetches both. */
export const REVIEW_KEY = ["reviews"] as const;
export const REVIEW_QUEUE_KEY = ["reviews", "queue"] as const;
export const REVIEW_DUE_KEY = ["reviews", "dueCount"] as const;

const QUEUE_LIMIT = 10;

const GRADES: {
  grade: ReviewGrade;
  label: string;
  hint: string;
  variant: "destructive" | "outline" | "default" | "secondary";
}[] = [
  { grade: 1, label: "Again", hint: "1", variant: "destructive" },
  { grade: 2, label: "Hard", hint: "2", variant: "outline" },
  { grade: 3, label: "Good", hint: "3", variant: "default" },
  { grade: 4, label: "Easy", hint: "4", variant: "secondary" },
];

function describeNextDue(schedule: ReviewScheduleDTO): string {
  const days = schedule.intervalDays;
  if (days === null) return "Scheduled.";
  if (days === 1) return "Back tomorrow.";
  return `Back in ${days} days.`;
}

export function ReviewPage() {
  const qc = useQueryClient();
  const [revealed, setRevealed] = useState(false);

  const queue = useQuery({
    queryKey: REVIEW_QUEUE_KEY,
    queryFn: ({ signal }) => api.reviewQueue({ limit: QUEUE_LIMIT, signal }),
  });

  const card: ReviewQueueItemDTO | null = queue.data?.items[0] ?? null;
  const dueCount = queue.data?.dueCount ?? 0;

  // The answer is a separate request made only once the user asks to see it —
  // that is what keeps the reveal out of the queue payload entirely.
  const answer = useQuery({
    queryKey: ["entry", card?.entryId ?? ""] as const,
    queryFn: ({ signal }) => api.getEntry(card?.entryId ?? "", signal),
    enabled: revealed && card !== null,
  });

  const gradeCard = useMutation({
    mutationFn: (vars: { entryId: string; grade: ReviewGrade }) =>
      api.gradeReview(vars.entryId, vars.grade),
    onSuccess: (schedule, vars) => {
      setRevealed(false);
      // Drop the graded card locally so the next question paints immediately
      // instead of flashing the card the user just answered.
      qc.setQueryData<ReviewQueueResponse>(REVIEW_QUEUE_KEY, (prev) =>
        prev
          ? {
              items: prev.items.filter((i) => i.entryId !== vars.entryId),
              dueCount: Math.max(0, prev.dueCount - 1),
            }
          : prev,
      );
      void qc.invalidateQueries({ queryKey: REVIEW_KEY });
      toast.success(GRADES.find((g) => g.grade === vars.grade)?.label ?? "Graded", {
        description: describeNextDue(schedule),
      });
    },
    onError: (e) => {
      toast.error("Could not save that answer", { description: friendlyMessage(e) });
    },
  });

  const enrollAll = useMutation({
    mutationFn: () => api.enrollReview({ all: true }),
    onSuccess: (result) => {
      if (result.enrolled === 0) {
        toast.info("Nothing new to add", {
          description:
            result.skipped > 0
              ? "Every saved entry is already in your review queue."
              : "Save a link first — there is nothing to review yet.",
        });
      } else {
        toast.success(
          `Added ${result.enrolled} ${result.enrolled === 1 ? "entry" : "entries"}`,
          { description: "They're due right away." },
        );
      }
      void qc.invalidateQueries({ queryKey: REVIEW_KEY });
    },
    onError: (e) => {
      toast.error("Could not add your entries", { description: friendlyMessage(e) });
    },
  });

  const pending = gradeCard.isPending;

  // Keyboard flow: space/enter reveals, 1-4 grades. A card review is a rhythm —
  // reaching for the mouse on every card kills it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (card === null || pending) return;
      if (!revealed) {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          setRevealed(true);
        }
        return;
      }
      const grade = Number(e.key);
      if (grade >= 1 && grade <= 4) {
        e.preventDefault();
        gradeCard.mutate({ entryId: card.entryId, grade: grade as ReviewGrade });
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [card, revealed, pending, gradeCard]);

  if (queue.isLoading) return <Spinner label="Loading your review queue…" />;

  if (queue.isError) {
    return <ErrorBanner error={queue.error} onRetry={() => queue.refetch()} />;
  }

  if (card === null) {
    return (
      <div className="space-y-4">
        <Header dueCount={0} />
        <Card className="gap-0 border-dashed bg-transparent p-8 text-center shadow-none">
          <p className="text-base font-medium">Nothing due. Nice work.</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Cards come back on their own schedule — check in again tomorrow.
          </p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => enrollAll.mutate()}
              disabled={enrollAll.isPending}
            >
              {enrollAll.isPending ? "Adding…" : "Add my saved entries"}
            </Button>
            <Button asChild variant="ghost">
              <Link to="/">Back to feed</Link>
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const title = card.title?.trim() || card.url;
  const takeaway = answer.data?.takeaway?.trim() ?? "";
  const summary = answer.data?.summary?.trim() ?? "";

  return (
    <div className="space-y-4">
      <Header dueCount={dueCount} />

      <Card className="gap-0 p-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{card.state}</Badge>
          {card.sourceDomain && <span>{card.sourceDomain}</span>}
          {card.lapses > 0 && (
            <span>
              {card.lapses} {card.lapses === 1 ? "lapse" : "lapses"}
            </span>
          )}
        </div>

        <h1 className="mt-3 text-xl font-semibold">{title}</h1>
        {card.question && (
          <p className="mt-2 text-base italic text-muted-foreground">
            {card.question}
          </p>
        )}

        {!revealed ? (
          <div className="mt-6">
            <Button type="button" onClick={() => setRevealed(true)}>
              Reveal
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Try to answer it first — then press space.
            </p>
          </div>
        ) : (
          <div className="mt-5 space-y-4 border-t pt-4">
            {answer.isLoading && <Spinner label="Loading the answer…" />}
            {answer.isError && (
              <ErrorBanner error={answer.error} onRetry={() => answer.refetch()} />
            )}
            {answer.isSuccess && (
              <>
                {takeaway !== "" && (
                  <section
                    aria-label="Takeaway"
                    className="rounded-md border-l-4 border-success bg-success/10 p-4"
                  >
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-success">
                      Takeaway
                    </h2>
                    <p className="mt-1 text-base">{takeaway}</p>
                  </section>
                )}
                {summary !== "" && (
                  <section aria-label="Summary">
                    <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      Summary
                    </h2>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{summary}</p>
                  </section>
                )}
                {takeaway === "" && summary === "" && (
                  <p className="text-sm text-muted-foreground">
                    This entry has no takeaway or summary yet.
                  </p>
                )}
                <Button asChild variant="link" size="xs" className="px-0">
                  <Link to={`/entries/${encodeURIComponent(card.entryId)}`}>
                    Open the full entry
                  </Link>
                </Button>
              </>
            )}

            <div className="flex flex-wrap gap-2 border-t pt-4">
              {GRADES.map(({ grade, label, hint, variant }) => (
                <Button
                  key={grade}
                  type="button"
                  variant={variant}
                  disabled={pending}
                  onClick={() => gradeCard.mutate({ entryId: card.entryId, grade })}
                  title={`${label} (${hint})`}
                >
                  {label}
                  <span aria-hidden="true" className="text-xs opacity-60">
                    {hint}
                  </span>
                </Button>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

function Header({ dueCount }: { dueCount: number }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="text-sm font-medium text-muted-foreground">Review</h2>
      <span className="text-sm text-muted-foreground">
        {dueCount === 0 ? "all caught up" : `${dueCount} due`}
      </span>
    </div>
  );
}
