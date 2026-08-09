import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const CORPUS_PATH = join(packageRoot, "fixtures", "corpus.json");
export const RETRIEVAL_GOLD_PATH = join(
  packageRoot,
  "datasets",
  "retrieval-gold.json",
);
export const CHAT_SCENARIOS_PATH = join(
  packageRoot,
  "datasets",
  "chat-scenarios.json",
);
export const INJECTION_SUITE_PATH = join(
  packageRoot,
  "datasets",
  "injection-suite.json",
);
export const EMBEDDING_CACHE_DIR = join(packageRoot, "fixtures", ".cache");
export const HISTORY_PATH = join(packageRoot, "history", "eval-history.jsonl");

export interface CorpusEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  takeaway: string;
  question: string;
  tags: string[];
  contentMarkdown: string;
}

export type GoldKind = "semantic" | "keyword" | "mixed";

export interface GoldCase {
  id: string;
  query: string;
  expected: string[];
  kind: GoldKind;
  note: string;
}

export interface ChatScenario {
  id: string;
  turns: string[];
  /** Tool the model is expected to reach for, or null when none should run. */
  expectTool: string | null;
  /** True when a correct answer cites nothing, because nothing was saved. */
  expectRefusal?: boolean;
  note: string;
}

export interface InjectionCase {
  id: string;
  seedEntry: CorpusEntry;
  question: string;
  canary: string;
  note: string;
}

/**
 * The text FTS5 actually indexes (see `0001_fts.sql`): `question` is absent from
 * the virtual table, so a word shared only with `question` cannot help the
 * keyword leg.
 */
export function indexedTextFor(entry: CorpusEntry): string {
  return [
    entry.title,
    entry.summary,
    entry.takeaway,
    entry.tags.join(" "),
    entry.contentMarkdown,
  ].join("\n");
}

export function loadCorpus(path: string = CORPUS_PATH): CorpusEntry[] {
  const rows = readJsonArray(path);
  const entries = rows.map((row, i) => parseCorpusEntry(row, `${path}[${i}]`));
  assertUniqueIds(
    entries.map((entry) => entry.id),
    path,
  );
  return entries;
}

export function loadRetrievalGold(
  path: string = RETRIEVAL_GOLD_PATH,
): GoldCase[] {
  const rows = readJsonArray(path);
  const cases: GoldCase[] = rows.map((row, i) => {
    const where = `${path}[${i}]`;
    const record = asRecord(row, where);
    const kind = str(record.kind, `${where}.kind`);
    if (kind !== "semantic" && kind !== "keyword" && kind !== "mixed") {
      throw new Error(`${where}.kind must be semantic|keyword|mixed`);
    }
    const expected = strArray(record.expected, `${where}.expected`);
    if (expected.length === 0) {
      throw new Error(`${where}.expected must name at least one entry`);
    }
    return {
      id: str(record.id, `${where}.id`),
      query: str(record.query, `${where}.query`),
      expected,
      kind,
      note: str(record.note, `${where}.note`),
    };
  });
  assertUniqueIds(
    cases.map((c) => c.id),
    path,
  );
  return cases;
}

export function loadChatScenarios(
  path: string = CHAT_SCENARIOS_PATH,
): ChatScenario[] {
  const rows = readJsonArray(path);
  const scenarios = rows.map((row, i) => {
    const where = `${path}[${i}]`;
    const record = asRecord(row, where);
    const turns = strArray(record.turns, `${where}.turns`);
    if (turns.length === 0) {
      throw new Error(`${where}.turns must contain at least one user turn`);
    }
    const rawTool = record.expectTool;
    if (rawTool !== null && typeof rawTool !== "string") {
      throw new Error(`${where}.expectTool must be a tool name or null`);
    }
    const scenario: ChatScenario = {
      id: str(record.id, `${where}.id`),
      turns,
      expectTool: rawTool,
      note: str(record.note, `${where}.note`),
    };
    if (record.expectRefusal !== undefined) {
      if (typeof record.expectRefusal !== "boolean") {
        throw new Error(`${where}.expectRefusal must be a boolean`);
      }
      scenario.expectRefusal = record.expectRefusal;
    }
    return scenario;
  });
  assertUniqueIds(
    scenarios.map((s) => s.id),
    path,
  );
  return scenarios;
}

export function loadInjectionSuite(
  path: string = INJECTION_SUITE_PATH,
): InjectionCase[] {
  const rows = readJsonArray(path);
  const cases = rows.map((row, i) => {
    const where = `${path}[${i}]`;
    const record = asRecord(row, where);
    return {
      id: str(record.id, `${where}.id`),
      seedEntry: parseCorpusEntry(record.seedEntry, `${where}.seedEntry`),
      question: str(record.question, `${where}.question`),
      canary: str(record.canary, `${where}.canary`),
      note: str(record.note, `${where}.note`),
    };
  });
  assertUniqueIds(
    cases.map((c) => c.id),
    path,
  );
  return cases;
}

function parseCorpusEntry(row: unknown, where: string): CorpusEntry {
  const record = asRecord(row, where);
  return {
    id: str(record.id, `${where}.id`),
    url: str(record.url, `${where}.url`),
    title: str(record.title, `${where}.title`),
    summary: str(record.summary, `${where}.summary`),
    takeaway: str(record.takeaway, `${where}.takeaway`),
    question: str(record.question, `${where}.question`),
    tags: strArray(record.tags, `${where}.tags`),
    contentMarkdown: str(record.contentMarkdown, `${where}.contentMarkdown`),
  };
}

function readJsonArray(path: string): unknown[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error(`${path} must be a JSON array`);
  return parsed;
}

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${where} must be a non-empty string`);
  }
  return value;
}

function strArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be an array`);
  return value.map((item, i) => str(item, `${where}[${i}]`));
}

function assertUniqueIds(ids: string[], path: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`${path} has a duplicate id: ${id}`);
    seen.add(id);
  }
}
