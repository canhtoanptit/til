import { useId, useState } from "react";
import { Link } from "react-router";
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

export function ChatToolPart({
  part,
  tool,
}: {
  part: ChatUIPart;
  tool: ChatToolName;
}) {
  const bodyId = useId();
  const [open, setOpen] = useState(false);
  const state = getToolPartState(part);
  const input = getToolInput(part);
  const output = getToolOutput(part);
  const pending = isToolPending(state);
  const stateLabel = toolStateLabel(state);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={bodyId}
        className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs text-slate-600 hover:bg-slate-100"
      >
        <span aria-hidden="true" className="leading-5">
          {toolIcon(tool)}
        </span>
        <span className="min-w-0 flex-1 leading-5">
          {toolSummary(tool, input, output, state)}
          {stateLabel && (
            <span className="text-slate-400"> — {stateLabel}</span>
          )}
        </span>
        {pending ? (
          <Spinner />
        ) : (
          <span aria-hidden="true" className="leading-5 text-slate-400">
            {open ? "▴" : "▾"}
          </span>
        )}
      </button>

      <div id={bodyId} hidden={!open} className="border-t border-slate-200 px-3 py-2">
        <ToolInput tool={tool} input={input} />
        {state === "error" && (
          <p className="mt-2 text-xs text-red-700">
            {toolErrorText(part) ?? "This lookup failed."}
          </p>
        )}
        {state === "complete" && (
          <div className="mt-2">
            <ToolOutput tool={tool} output={output} />
          </div>
        )}
        {pending && (
          <p className="mt-2 text-xs text-slate-500">Waiting for the result…</p>
        )}
        <p className="mt-2 font-mono text-[10px] text-slate-400">
          call {getToolCallId(part)}
        </p>
      </div>
    </div>
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
      return <p className="text-xs text-slate-500">No matching entries.</p>;
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
      return <p className="text-xs text-slate-500">That entry no longer exists.</p>;
    }
    return (
      <article className="rounded border border-slate-200 bg-white p-3">
        <Link
          to={`/entries/${encodeURIComponent(entry.id)}`}
          className="text-sm font-semibold text-slate-900 hover:underline"
        >
          {entry.title?.trim() || entry.url}
        </Link>
        {entry.takeaway && (
          <p className="mt-2 text-xs text-slate-700">{entry.takeaway}</p>
        )}
        {entry.summary && (
          <p className="mt-2 text-xs text-slate-600">{entry.summary}</p>
        )}
        {entry.question && (
          <p className="mt-2 text-xs italic text-slate-500">{entry.question}</p>
        )}
        <TagList tags={entry.tags} />
      </article>
    );
  }

  const stats = parseStatsResult(output);
  if (stats.rows.length === 0) {
    return <p className="text-xs text-slate-500">Nothing to report yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded border border-slate-200 bg-white">
      <table className="w-full text-left text-xs">
        <caption className="px-2 pt-2 text-left text-[11px] text-slate-500">
          {statsLabel(stats.kind)}
        </caption>
        <thead>
          <tr className="text-slate-500">
            {stats.columns.map((column) => (
              <th key={column} scope="col" className="px-2 py-1 font-medium">
                {statsColumnLabel(column)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {stats.rows.map((row, index) => (
            <tr key={index} className="border-t border-slate-100 text-slate-700">
              {stats.columns.map((column) => (
                <td key={column} className="px-2 py-1">
                  {row[column] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HitCard({ hit }: { hit: ChatSearchHit }) {
  const date = formatShortDate(hit.createdAt);
  return (
    <article className="rounded border border-slate-200 bg-white p-2.5">
      <Link
        to={`/entries/${encodeURIComponent(hit.id)}`}
        className="text-sm font-medium text-slate-900 hover:underline"
      >
        {hit.title?.trim() || hit.url}
      </Link>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
        {hit.sourceDomain && <span>{hit.sourceDomain}</span>}
        {hit.sourceDomain && date && <span aria-hidden="true">·</span>}
        {date && <span>{date}</span>}
      </div>
      {hit.takeaway && (
        <p className="mt-1.5 line-clamp-2 text-xs text-slate-600">{hit.takeaway}</p>
      )}
      <TagList tags={hit.tags} />
    </article>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1">
      {tags.map((tag) => (
        <li
          key={tag}
          className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-600"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}

function Fields({ fields }: { fields: [string, string | null][] }) {
  const present = fields.filter((f): f is [string, string] => f[1] !== null);
  if (present.length === 0) {
    return <p className="text-xs text-slate-500">No arguments.</p>;
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      {present.map(([label, value]) => (
        <div key={label} className="col-span-2 grid grid-cols-subgrid">
          <dt className="text-slate-500">{label}</dt>
          <dd className="break-words text-slate-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

