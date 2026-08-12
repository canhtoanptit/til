import { CalendarRangeIcon } from "lucide-react";
import type { DigestKind } from "../api";
import { digestKindLabel } from "./digest-format";
import { Badge } from "@/components/ui/badge";

/**
 * Which flavour of run a row is. One component for the list and the detail page so
 * the two can never drift apart.
 *
 * The monthly report is distinguished by an outline + icon rather than a hue: the
 * palette's only hue-stable tokens across light and dark are already spoken for
 * (`success` marks "matches your reading", `destructive` marks failures), and the
 * chart tokens are not hue-stable between themes — `--chart-2` is literally equal
 * to `--success` in the dark theme. `primary` is near-black in light and near-white
 * in dark, so a /30 border and a /5 wash read as the same "quietly emphasized"
 * chip in both, and the icon carries the rest of the distinction.
 */
export function DigestKindBadge({ kind }: { kind: DigestKind }) {
  const label = digestKindLabel(kind);
  if (kind === "monthly-report") {
    return (
      <Badge
        variant="outline"
        className="border-primary/30 bg-primary/5 font-normal"
        title="A retrospective over the entries you saved this month, not a roundup of external links."
      >
        <CalendarRangeIcon aria-hidden="true" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="border-transparent bg-muted font-normal text-muted-foreground"
      title="A roundup of interesting things from Hacker News, Lobsters, arXiv and your RSS feeds."
    >
      {label}
    </Badge>
  );
}
