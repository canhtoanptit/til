import { useId } from "react";
import { Link } from "react-router";
import { ChevronDownIcon } from "lucide-react";
import {
  getToolCallId,
  getToolInput,
  getToolOutput,
  getToolPartState,
} from "@cloudflare/ai-chat/react";
import { Spinner } from "./Spinner";
import {
  formatShortDate,
  isToolPending,
  parseEntryInput,
  parseEntryResult,
  parseSearchHits,
  parseSearchInput,
  parseStatsInput,
  parseStatsResult,
  statsColumnLabel,
  statsLabel,
  toolErrorText,
  toolIcon,
  toolStateLabel,
  toolSummary,
  type ChatSearchHit,
  type ChatToolName,
  type ChatUIPart,
} from "./chat-format";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export function ChatToolPart({
  part,
  tool,
}: {
  part: ChatUIPart;
  tool: ChatToolName;
}) {
  const bodyId = useId();
  const state = getToolPartState(part);
  const input = getToolInput(part);
  const output = getToolOutput(part);
  const pending = isToolPending(state);
  const stateLabel = toolStateLabel(state);

  return (
    // Radix owns aria-expanded, data-state and the open/close state. It does
    // not emit aria-controls, so we keep wiring that by hand to preserve the
    // disclosure semantics the hand-rolled version had.
    <Collapsible className="rounded-lg border bg-muted/40">
      <CollapsibleTrigger
        aria-controls={bodyId}
        className="group flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span aria-hidden="true" className="leading-5">
          {toolIcon(tool)}
        </span>
        <span className="min-w-0 flex-1 leading-5">
          {toolSummary(tool, input, output, state)}
          {stateLabel && <span className="opacity-70"> — {stateLabel}</span>}
        </span>
        {pending ? (
          <Spinner />
        ) : (
          <ChevronDownIcon
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          />
        )}
      </CollapsibleTrigger>

      <CollapsibleContent id={bodyId} className="border-t px-3 py-2">
        <ToolInput tool={tool} input={input} />
        {state === "error" && (
          <p className="mt-2 text-xs text-destructive">
            {toolErrorText(part) ?? "This lookup failed."}
          </p>
        )}
        {state === "complete" && (
          <div className="mt-2">
            <ToolOutput tool={tool} output={output} />
          </div>
        )}
        {pending && (
          <p className="mt-2 text-xs text-muted-foreground">
            Waiting for the result…
          </p>
        )}
        <p className="mt-2 font-mono text-[10px] text-muted-foreground/70">
          call {getToolCallId(part)}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ToolInput({ tool, input }: { tool: ChatToolName; input: unknown }) {
  if (tool === "search_entries") {
    const args = parseSearchInput(input);
    return (
      <Fields
        fields={[
          ["query", args.query],
          ["tag", args.tag],
          ["since", args.sinceDays === null ? null : `${args.sinceDays} days`],
          ["max results", args.topK === null ? null : String(args.topK)],
        ]}
      />
    );
  }
  if (tool === "get_entry") {
    return <Fields fields={[["entry id", parseEntryInput(input).id]]} />;
  }
  const args = parseStatsInput(input);
  return (
    <Fields
      fields={[
        ["stat", args.kind === null ? null : statsLabel(args.kind)],
        ["since", args.sinceDays === null ? null : `${args.sinceDays} days`],
      ]}
    />
  );
}

function ToolOutput({ tool, output }: { tool: ChatToolName; output: unknown }) {
  if (tool === "search_entries") {
    const hits = parseSearchHits(output);
    if (hits.length === 0) {
      return (
        <p className="text-xs text-muted-foreground">No matching entries.</p>
      );
    }
    return (
      <ul className="space-y-2">
        {hits.map((hit) => (
          <li key={hit.id}>
            <HitCard hit={hit} />
          </li>
        ))}
      </ul>
    );
  }

  if (tool === "get_entry") {
    const entry = parseEntryResult(output);
    if (entry === null) {
      return (
        <p className="text-xs text-muted-foreground">
          That entry no longer exists.
        </p>
      );
    }
    return (
      <Card asChild className="gap-0 p-3">
        <article>
          <Link
            to={`/entries/${encodeURIComponent(entry.id)}`}
            className="text-sm font-semibold hover:underline"
          >
            {entry.title?.trim() || entry.url}
          </Link>
          {entry.takeaway && <p className="mt-2 text-xs">{entry.takeaway}</p>}
          {entry.summary && (
            <p className="mt-2 text-xs text-muted-foreground">
              {entry.summary}
            </p>
          )}
          {entry.question && (
            <p className="mt-2 text-xs italic text-muted-foreground">
              {entry.question}
            </p>
          )}
          <TagList tags={entry.tags} />
        </article>
      </Card>
    );
  }

  const stats = parseStatsResult(output);
  if (stats.rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">Nothing to report yet.</p>
    );
  }
  return (
    <div className="rounded-md border bg-card">
      <Table className="text-xs">
        <TableCaption className="mt-0 px-2 pt-2 text-left text-[11px]">
          {statsLabel(stats.kind)}
        </TableCaption>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {stats.columns.map((column) => (
              <TableHead
                key={column}
                scope="col"
                className="h-8 text-muted-foreground"
              >
                {statsColumnLabel(column)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats.rows.map((row, index) => (
            <TableRow key={index}>
              {stats.columns.map((column) => (
                <TableCell key={column} className="py-1">
                  {row[column] ?? ""}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

function HitCard({ hit }: { hit: ChatSearchHit }) {
  const date = formatShortDate(hit.createdAt);
  return (
    <Card asChild className="gap-0 p-2.5">
      <article>
        <Link
          to={`/entries/${encodeURIComponent(hit.id)}`}
          className="text-sm font-medium hover:underline"
        >
          {hit.title?.trim() || hit.url}
        </Link>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
          {hit.sourceDomain && <span>{hit.sourceDomain}</span>}
          {hit.sourceDomain && date && <span aria-hidden="true">·</span>}
          {date && <span>{date}</span>}
        </div>
        {hit.takeaway && (
          <p className="mt-1.5 line-clamp-2 text-xs text-muted-foreground">
            {hit.takeaway}
          </p>
        )}
        <TagList tags={hit.tags} />
      </article>
    </Card>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li key={tag}>
          <Badge variant="secondary" className="px-1.5 py-0 text-[10px]">
            {tag}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function Fields({ fields }: { fields: [string, string | null][] }) {
  const present = fields.filter((f): f is [string, string] => f[1] !== null);
  if (present.length === 0) {
    return <p className="text-xs text-muted-foreground">No arguments.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {present.map(([label, value]) => (
        <div key={label} className="col-span-2 grid grid-cols-subgrid">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
