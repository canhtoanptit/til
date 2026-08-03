import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@til/db";
import { entries } from "@til/db";
import { createApp } from "./app.js";
import type { Deps, FetchPageFn } from "./deps.js";
import type { Extractor, LLMClient } from "@til/core";
import type { VectorizeLike } from "./vectorize.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(__dirname, "../../../../packages/db/migrations");

interface TestDbBundle {
  db: Deps["db"];
  sqlite: Database.Database;
}

export function createTestDb(): TestDbBundle {
  const sqlite = new Database(":memory:");
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
    ping: overrides?.ping ?? (async () => ({ ok: true })),
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
