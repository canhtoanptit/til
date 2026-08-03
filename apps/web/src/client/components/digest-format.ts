import type { DigestSummaryDTO } from "../api";

const DAY_MS = 86_400_000;

const SOURCE_LABELS: Record<string, string> = {
  hn: "Hacker News",
  lobsters: "Lobsters",
  arxiv: "arXiv",
  rss: "RSS",
};

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

/** Title once the LLM has written one; otherwise the window it covers. */
export function digestHeading(digest: DigestSummaryDTO): string {
  const title = digest.title?.trim();
  if (title) return title;
  const range = formatWindowRange(digest.runAt, digest.windowDays);
  return range ? `Digest · ${range}` : "Digest";
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
