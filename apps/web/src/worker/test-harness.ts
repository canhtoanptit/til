import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@til/db";
import { digestItems, digests, entries } from "@til/db";
import { createApp } from "./app.js";
import type { Deps, FetchPageFn } from "./deps.js";
import type {
  Candidate,
  Extractor,
  LLMClient,
  SourceAdapter,
} from "@til/core";
import type {
  DigestRunParams,
  DigestStep,
  DigestStepConfig,
  DigestWorkflowBinding,
} from "./digest.js";
import type { VectorizeLike } from "./vectorize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "../../../../packages/db/migrations");

interface TestDbBundle {
  db: Deps["db"];
  sqlite: Database.Database;
}

export function createTestDb(): TestDbBundle {
  const sqlite = new Database(":memory:");
  // WHY: SQLite disables FK enforcement per connection, so without this the
  // digest_items → digests cascade would silently not fire in tests.
  sqlite.pragma("foreign_keys = ON");
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    sqlite.exec(sql);
  }
  // WHY: drizzle/better-sqlite3 client typing differs from D1 but shares the API surface
  // used by the routes (select/insert/update/delete/all with sql template).
  const db = drizzle(sqlite, { schema }) as unknown as Deps["db"];
  return { db, sqlite };
}

export interface TestOverrides {
  now?: () => number;
  extractor?: Extractor;
  llmFactory?: Deps["llmFactory"];
  vectorize?: VectorizeLike | null;
  embed?: Deps["embed"];
  fetchPage?: FetchPageFn;
  fetchImpl?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
  appToken?: string;
  adapters?: Deps["adapters"];
  digestWorkflow?: DigestWorkflowBinding | null;
}

export function makeStubLLM(overrides?: Partial<LLMClient>): LLMClient {
  return {
    digest: overrides?.digest ??
      (async () => ({
        title: "Stub Title",
        summary: "Stub summary body.",
        takeaway: "Stub takeaway line.",
        question: "What is the stub question?",
        tags: ["alpha", "beta", "gamma"],
      })),
    synthesizeDigest: overrides?.synthesizeDigest ??
      (async (inputs, opts) => ({
        title: "Stub Digest",
        intro: "Stub digest intro.",
        items: inputs.slice(0, opts.maxItems).map((input) => ({
          canonicalUrl: input.canonicalUrl,
          title: input.title,
          why: `Stub reason for ${input.canonicalUrl}.`,
        })),
      })),
    ping: overrides?.ping ?? (async () => ({ ok: true })),
  };
}

export function makeStubAdapter(
  name: string,
  result: Candidate[] | Error,
): SourceAdapter {
  return {
    name,
    fetchCandidates: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

export interface RecordedRun {
  id: string | undefined;
  params: DigestRunParams | undefined;
}

export interface RecordingWorkflow {
  binding: DigestWorkflowBinding;
  created: RecordedRun[];
}

export function createRecordingWorkflow(
  onCreate?: (run: RecordedRun) => Promise<void> | void,
): RecordingWorkflow {
  const created: RecordedRun[] = [];
  return {
    created,
    binding: {
      create: async (options) => {
        const run: RecordedRun = {
          id: options?.id,
          params: options?.params,
        };
        created.push(run);
        await onCreate?.(run);
        return { id: run.id ?? "stub-instance" };
      },
    },
  };
}

export interface InlineStepBundle {
  step: DigestStep;
  names: string[];
  configs: DigestStepConfig[];
}

/** Runs each step body once, in place — no durability, no retries. */
export function inlineStep(): InlineStepBundle {
  const names: string[] = [];
  const configs: DigestStepConfig[] = [];
  return {
    names,
    configs,
    step: {
      do: async <T,>(
        name: string,
        config: DigestStepConfig,
        fn: () => Promise<T>,
      ): Promise<T> => {
        names.push(name);
        configs.push(config);
        return fn();
      },
    },
  };
}

export function makeStubExtractor(): Extractor {
  return {
    toMarkdown: async (_html, _url) => ({
      markdown: "hello world",
      title: "Stub Title",
    }),
  };
}

export function buildTestApp(overrides: TestOverrides = {}) {
  const { db } = createTestDb();
  const waitPromises: Promise<unknown>[] = [];
  const deps: Deps = {
    db,
    now: overrides.now ?? (() => 1_700_000_000_000),
    llmFactory: overrides.llmFactory ?? (() => makeStubLLM()),
    extractor: overrides.extractor ?? makeStubExtractor(),
    vectorize: overrides.vectorize ?? null,
    embed: overrides.embed ?? (async () => null),
    fetchPage:
      overrides.fetchPage ??
      (async () => ({
        html: "<html><head><title>t</title></head><body>hi</body></html>",
        finalUrl: "https://example.com/x",
      })),
    fetchImpl: overrides.fetchImpl ?? (globalThis.fetch as typeof fetch),
    waitUntil: (p) => {
      waitPromises.push(p);
      overrides.waitUntil?.(p);
    },
    adapters: overrides.adapters ?? (() => []),
    digestWorkflow:
      overrides.digestWorkflow === undefined
        ? createRecordingWorkflow().binding
        : overrides.digestWorkflow,
  };

  const env = { APP_TOKEN: overrides.appToken ?? "dev-token" };
  const app = createApp(() => deps);
  const request = async (
    path: string,
    init?: RequestInit & { auth?: boolean },
  ) => {
    const headers = new Headers(init?.headers ?? {});
    if (init?.auth !== false) {
      headers.set("authorization", `Bearer ${env.APP_TOKEN}`);
    }
    const res = await app.fetch(
      new Request(`http://test.local${path}`, {
        method: init?.method,
        headers,
        body: init?.body,
      }),
      env,
    );
    return res;
  };
  const flush = async () => {
    while (waitPromises.length > 0) {
      const p = waitPromises.shift();
      if (p) await p;
    }
  };
  return { app, deps, env, request, flush };
}

export async function insertDigest(
  db: Deps["db"],
  overrides: {
    id?: string;
    runAt?: number;
    windowDays?: number;
    status?: "pending" | "ready" | "failed";
    title?: string | null;
    intro?: string | null;
    error?: string | null;
    createdAt?: number;
    updatedAt?: number;
  } = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const runAt = overrides.runAt ?? Date.now();
  await db.insert(digests).values({
    id,
    runAt,
    windowDays: overrides.windowDays ?? 7,
    status: overrides.status ?? "ready",
    title: overrides.title ?? "Weekly digest",
    intro: overrides.intro ?? "Intro paragraph.",
    error: overrides.error ?? null,
    createdAt: overrides.createdAt ?? runAt,
    updatedAt: overrides.updatedAt ?? runAt,
  });
  return id;
}

export async function insertDigestItem(
  db: Deps["db"],
  digestId: string,
  overrides: {
    id?: string;
    rank?: number;
    title?: string;
    url?: string;
    sourceName?: string;
    sourceDomain?: string;
    score?: number;
    why?: string | null;
    evidence?: { url: string; sourceName: string; title: string }[];
    createdAt?: number;
  } = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const rank = overrides.rank ?? 1;
  await db.insert(digestItems).values({
    id,
    digestId,
    rank,
    title: overrides.title ?? `Item ${rank}`,
    url: overrides.url ?? `https://example.com/item-${rank}`,
    sourceName: overrides.sourceName ?? "hn",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    score: overrides.score ?? 0.5,
    why: overrides.why ?? "Because it matters.",
    evidence: JSON.stringify(overrides.evidence ?? []),
    createdAt: overrides.createdAt ?? Date.now(),
  });
  return id;
}

export function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    url: overrides.url ?? "https://example.com/a",
    title: overrides.title ?? "A rather interesting thing happened",
    sourceName: overrides.sourceName ?? "hn",
    publishedAt: overrides.publishedAt ?? 1_700_000_000_000,
    ...(overrides.popularity === undefined
      ? {}
      : { popularity: overrides.popularity }),
    ...(overrides.snippet === undefined ? {} : { snippet: overrides.snippet }),
  };
}

export async function insertEntry(
  db: Deps["db"],
  overrides: {
    id?: string;
    url?: string;
    canonicalUrl?: string;
    status?: "pending" | "ready" | "failed";
    createdAt?: number;
    updatedAt?: number;
    tags?: string[];
    title?: string;
    summary?: string;
    takeaway?: string;
    question?: string;
    sourceDomain?: string;
  } = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const now = overrides.createdAt ?? Date.now();
  await db.insert(entries).values({
    id,
    url: overrides.url ?? "https://example.com/a",
    canonicalUrl: overrides.canonicalUrl ?? "https://example.com/a",
    title: overrides.title ?? "T",
    summary: overrides.summary ?? "S",
    takeaway: overrides.takeaway ?? "K",
    question: overrides.question ?? "Q",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    tags: JSON.stringify(overrides.tags ?? []),
    status: overrides.status ?? "ready",
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
  return id;
}
