import type { DigestKind, DigestSummaryDTO } from "../api";

const DAY_MS = 86_400_000;

const SOURCE_LABELS: Record<string, string> = {
  hn: "Hacker News",
  lobsters: "Lobsters",
  arxiv: "arXiv",
  rss: "RSS",
  // What a monthly report writes for every item: the source is your own library.
  // Mirrors REPORT_ITEM_SOURCE_NAME in apps/web/src/worker/digest-run.ts.
  saved: "Saved",
};

export function digestKindLabel(kind: DigestKind): string {
  return kind === "monthly-report" ? "Monthly report" : "Weekly digest";
}

/**
 * What to say when a run is requested. Shared by the list page's two buttons and
 * the detail page's "Run again", so the same kind never gets two different
 * descriptions of what it is doing.
 */
export function digestRunCopy(kind: DigestKind): {
  startedTitle: string;
  startedDescription: string;
  failedTitle: string;
} {
  return kind === "monthly-report"
    ? {
        startedTitle: "Report run started",
        startedDescription:
          "Reading back over the month — this takes a minute or two.",
        failedTitle: "Could not start a report run",
      }
    : {
        startedTitle: "Digest run started",
        startedDescription:
          "Gathering and ranking candidates — this takes a minute or two.",
        failedTitle: "Could not start a digest run",
      };
}

export function formatRunDate(ms: number): string {
  if (!Number.isFinite(ms)) return "";
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

export function formatRunDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "";
  }
}

export function formatWindowRange(runAt: number, windowDays: number): string {
  if (!Number.isFinite(runAt) || !Number.isFinite(windowDays)) return "";
  try {
    const end = new Date(runAt);
    const start = new Date(runAt - windowDays * DAY_MS);
    const startStr = start.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const endStr = end.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    return `${startStr} – ${endStr}`;
  } catch {
    return "";
  }
}

/** Title once the LLM has written one; otherwise the kind and the window it covers. */
export function digestHeading(digest: DigestSummaryDTO): string {
  const title = digest.title?.trim();
  if (title) return title;
  const label = digestKindLabel(digest.kind);
  const range = formatWindowRange(digest.runAt, digest.windowDays);
  return range ? `${label} · ${range}` : label;
}

export function sourceLabel(sourceName: string): string {
  if (sourceName.startsWith("rss:")) {
    const host = sourceName.slice("rss:".length);
    return host ? `RSS · ${host}` : "RSS";
  }
  return SOURCE_LABELS[sourceName] ?? sourceName;
}

export function formatItemCount(n: number): string {
  if (!Number.isFinite(n)) return "0 items";
  return n === 1 ? "1 item" : `${n} items`;
}

export function formatScore(score: number): string | null {
  return Number.isFinite(score) ? score.toFixed(2) : null;
}

/**
 * The blend weights from C18. Mirrored here rather than imported: the client bundle
 * is deliberately free of worker and `@til/core` code (see how api.ts restates the
 * DTOs). Source of truth: `BASE_SCORE_WEIGHT` / `INTEREST_SCORE_WEIGHT` in
 * `apps/web/src/worker/digest.ts` — change these together or the marker starts
 * describing a blend the ranking no longer uses.
 */
const BASE_SCORE_WEIGHT = 0.6;
const INTEREST_SCORE_WEIGHT = 0.4;

/**
 * Whether to mark an item as "matches your reading". The definition: the interest
 * term contributed strictly more to the blended score than the base term did —
 * `0.4 * interest > 0.6 * base` — i.e. this item is here more because it resembles
 * what you save than because the internet was loud about it.
 *
 * A null `interestScore` means the run was not personalized, which is never a
 * match: an unmeasured item must not be marked, least of all one whose base score
 * happens to be 0.
 */
export function matchesYourReading(
  score: number,
  interestScore: number | null,
): boolean {
  if (interestScore === null || !Number.isFinite(interestScore)) return false;
  if (!Number.isFinite(score)) return false;
  const interest = Math.min(1, Math.max(0, interestScore));
  return INTEREST_SCORE_WEIGHT * interest > BASE_SCORE_WEIGHT * score;
}
