import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { HISTORY_PATH } from "./datasets.js";

export interface TableColumn {
  key: string;
  label: string;
  /** Fixed decimals for numeric cells; omit to print the value as given. */
  decimals?: number;
}

export type TableRow = Record<string, string | number>;

/** Left-aligned first column, right-aligned rest — readable in a plain terminal. */
export function renderTable(columns: TableColumn[], rows: TableRow[]): string {
  const cells = rows.map((row) =>
    columns.map((column) => formatCell(row[column.key], column.decimals)),
  );
  const widths = columns.map((column, i) =>
    Math.max(column.label.length, ...cells.map((row) => (row[i] ?? "").length)),
  );
  const line = (values: string[]): string =>
    values
      .map((value, i) =>
        i === 0 ? value.padEnd(widths[i] ?? 0) : value.padStart(widths[i] ?? 0),
      )
      .join("  ");

  const out: string[] = [
    line(columns.map((column) => column.label)),
    widths.map((width) => "-".repeat(width)).join("  "),
  ];
  for (const row of cells) out.push(line(row));
  return out.join("\n");
}

export function printTable(
  title: string,
  columns: TableColumn[],
  rows: TableRow[],
): void {
  console.log(`\n${title}`);
  console.log(renderTable(columns, rows));
}

export interface HistoryEntry {
  timestamp: string;
  gitSha: string;
  suite: string;
  config: Record<string, unknown>;
  scores: Record<string, unknown>;
}

/**
 * One JSON object per line, appended forever: comparing two runs must never
 * depend on remembering what the numbers were last week. The file is
 * commit-able, so nothing secret may enter `config` or `scores`.
 */
export function appendHistory(
  entry: HistoryEntry,
  path: string = HISTORY_PATH,
): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
}

export function gitSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function formatCell(
  value: string | number | undefined,
  decimals?: number,
): string {
  if (value === undefined) return "";
  if (typeof value === "number") {
    return decimals === undefined ? String(value) : value.toFixed(decimals);
  }
  return value;
}
