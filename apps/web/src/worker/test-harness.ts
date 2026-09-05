import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@til/db";
import {
  OWNER_USER_ID,
  digestItems,
  digests,
  entries,
  feeds,
  sessions,
  settings,
  users,
} from "@til/db";
import { createApp } from "./app.js";
import type { ChatMessageDTO } from "./chat-dto.js";
import type {
  AppBindings,
  ChatAgentBinding,
  ChatConversationStub,
  Deps,
  FetchPageFn,
  SessionUser,
} from "./deps.js";
import { upsertGoogleUser } from "./identity.js";
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  createSession,
  randomHex,
} from "./session.js";
import type {
  Candidate,
  ContentType,
  DigestKind,
  Embedder,
  Extractor,
  LLMClient,
  SourceAdapter,
  StackMode,
  VectorStore,
} from "@til/core";
import { EMBEDDING_DIMENSIONS, normalizeVector } from "@til/core";
import type {
  DigestRunParams,
  DigestStep,
  DigestStepConfig,
  DigestWorkflowBinding,
} from "./digest.js";
import { D1VectorStore } from "./vector-store.js";

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
  stack?: StackMode;
  extractor?: Extractor;
  llmFactory?: Deps["llmFactory"];
  embedder?: Embedder | null;
  vectorStore?: VectorStore | null;
  probeEmbedder?: Deps["probeEmbedder"];
  fetchPage?: FetchPageFn;
  fetchImpl?: typeof fetch;
  waitUntil?: (p: Promise<unknown>) => void;
  /**
   * Worker bindings. Merged over the defaults below; an explicitly `undefined`
   * value *unsets* the default, which is how a test models an unconfigured
   * secret (e.g. `{ GOOGLE_CLIENT_ID: undefined }` → 503 from the auth routes).
   */
  env?: Partial<
    Record<
      | "TIL_STACK"
      | "GOOGLE_CLIENT_ID"
      | "GOOGLE_CLIENT_SECRET"
      | "OWNER_EMAIL"
      | "ENTRY_DAILY_LIMIT",
      string | undefined
    >
  >;
  adapters?: Deps["adapters"];
  digestWorkflow?: DigestWorkflowBinding | null;
  chatAgents?: ChatAgentBinding | null;
}

export interface RecordingChatAgents {
  binding: ChatAgentBinding;
  opened: string[];
  cleared: string[];
  routed: Request[];
  messages: Map<string, ChatMessageDTO[]>;
}

/**
 * Stand-in for the chat Durable Object. A real DO needs workerd, which the plain
 * vitest runner does not provide, so route tests exercise the binding seam and
 * the live agent lifecycle is verified against `wrangler dev` instead.
 */
export function createRecordingChatAgents(
  opts: { route?: () => Response | null } = {},
): RecordingChatAgents {
  const opened: string[] = [];
  const cleared: string[] = [];
  const routed: Request[] = [];
  const messages = new Map<string, ChatMessageDTO[]>();
  const binding: ChatAgentBinding = {
    get: async (id): Promise<ChatConversationStub> => {
      opened.push(id);
      return {
        chatMessages: async () => messages.get(id) ?? [],
        clearChat: async () => {
          cleared.push(id);
          messages.delete(id);
        },
      };
    },
    route: async (request) => {
      routed.push(request);
      return opts.route?.() ?? null;
    },
  };
  return { binding, opened, cleared, routed, messages };
}

/**
 * Deterministic stand-in for bge-m3: every text is projected onto a fixed set of
 * "topic" axes by keyword, so semantically related texts land close together
 * without a model. Unit-length, like every real Embedder.
 */
export function makeStubEmbedder(
  topics: string[][],
  opts: { dimensions?: number; onEmbed?: (texts: string[]) => void } = {},
): Embedder {
  const dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
  return {
    model: "stub-embed",
    dimensions,
    embed: async (texts) => {
      opts.onEmbed?.(texts);
      return texts.map((text) => {
        const lower = text.toLowerCase();
        const raw: number[] = new Array<number>(dimensions).fill(0);
        topics.forEach((words, axis) => {
          if (axis >= dimensions) return;
          let hits = 0;
          for (const word of words) {
            if (lower.includes(word)) hits += 1;
          }
          raw[axis] = hits;
        });
        // WHY: an all-zero vector scores 0 against everything, which would make
        // "no keyword matched" indistinguishable from "vector store empty".
        let total = 0;
        for (const value of raw) total += value;
        if (total === 0) raw[dimensions - 1] = 1;
        return normalizeVector(raw);
      });
    },
  };
}

export function makeThrowingEmbedder(message = "ollama unreachable"): Embedder {
  return {
    model: "stub-embed",
    dimensions: EMBEDDING_DIMENSIONS,
    embed: async () => {
      throw new Error(message);
    },
  };
}

export function makeStubLLM(overrides?: Partial<LLMClient>): LLMClient {
  return {
    digest:
      overrides?.digest ??
      (async () => ({
        title: "Stub Title",
        summary: "Stub summary body.",
        takeaway: "Stub takeaway line.",
        question: "What is the stub question?",
        tags: ["alpha", "beta", "gamma"],
      })),
    synthesizeDigest:
      overrides?.synthesizeDigest ??
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
      do: async <T>(
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

/** The tenant every legacy fixture row is backfilled to (migration 0012). */
export const TEST_USER_ID = OWNER_USER_ID;

/** The session `request()` sends when a test does not ask for anyone else. */
export const TEST_SESSION_ID = "0".repeat(64);

export interface TestSignIn {
  user: SessionUser;
  sessionId: string;
  cookie: string;
}

/**
 * Written out rather than inferred: `sqlite` is a better-sqlite3 handle, and
 * declaration emit cannot synthesise a name for that type from an inferred
 * return (TS4058). The explicit annotation gives it one.
 */
export interface TestApp {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  env: AppBindings;
  request: (
    path: string,
    init?: RequestInit & { auth?: boolean; user?: string },
  ) => Promise<Response>;
  flush: () => Promise<void>;
  loginAs: (email: string) => Promise<TestSignIn>;
  sqlite: Database.Database;
}

export function buildTestApp(overrides: TestOverrides = {}): TestApp {
  const { db, sqlite } = createTestDb();
  const waitPromises: Promise<unknown>[] = [];
  const now = overrides.now ?? (() => 1_700_000_000_000);
  const embedder = overrides.embedder ?? null;
  // WHY: a vector store without an embedder is dead weight, so default the store
  // on only when a test supplies an embedder — mirrors how resolveStack pairs them.
  const vectorStore =
    overrides.vectorStore === undefined
      ? embedder === null
        ? null
        : new D1VectorStore(db, embedder.dimensions, now)
      : overrides.vectorStore;
  const deps: Deps = {
    db,
    now,
    stack: overrides.stack ?? "local",
    llmFactory: overrides.llmFactory ?? (() => makeStubLLM()),
    extractor: overrides.extractor ?? makeStubExtractor(),
    embedder,
    vectorStore,
    probeEmbedder:
      overrides.probeEmbedder ??
      (async () => (embedder === null ? "unavailable" : "ok")),
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
    chatAgents:
      overrides.chatAgents === undefined
        ? createRecordingChatAgents().binding
        : overrides.chatAgents,
  };

  // Claim the migration-seeded owner row as the default test user, then open a
  // session for it. Raw sqlite, not drizzle, so `buildTestApp` stays
  // synchronous — every existing test calls it without `await`.
  sqlite
    .prepare(
      `insert into users (id, google_sub, email, name, picture, created_at, updated_at)
       values (?, 'test:owner', 'owner@test.local', 'Owner', null, ?, ?)
       on conflict(id) do update set google_sub = 'test:owner',
         email = 'owner@test.local', updated_at = excluded.updated_at`,
    )
    .run(TEST_USER_ID, now(), now());
  sqlite
    .prepare(
      "insert into sessions (id, user_id, created_at, expires_at) values (?, ?, ?, ?)",
    )
    .run(TEST_SESSION_ID, TEST_USER_ID, now(), now() + SESSION_TTL_MS);

  const env: AppBindings = {
    TIL_STACK: "local",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: "test-client-secret",
    OWNER_EMAIL: "owner@test.local",
  };
  for (const [key, value] of Object.entries(overrides.env ?? {})) {
    const name = key as keyof AppBindings;
    if (value === undefined) delete env[name];
    else env[name] = value;
  }

  const app = createApp(() => deps);

  // One session per extra test user, created on first use and reused after —
  // so `{ user: "alice" }` behaves like a browser that stays signed in.
  const userSessions = new Map<string, string>();
  const ensureUser = async (id: string): Promise<string> => {
    const cached = userSessions.get(id);
    if (cached !== undefined) return cached;
    const stamp = now();
    await db
      .insert(users)
      .values({
        id,
        googleSub: `test:${id}`,
        email: `${id}@test.local`,
        name: null,
        picture: null,
        createdAt: stamp,
        updatedAt: stamp,
      })
      .onConflictDoNothing();
    const sessionId = `sess-${randomHex(16)}`;
    await db.insert(sessions).values({
      id: sessionId,
      userId: id,
      createdAt: stamp,
      expiresAt: stamp + SESSION_TTL_MS,
    });
    userSessions.set(id, sessionId);
    return sessionId;
  };

  const request = async (
    path: string,
    init?: RequestInit & { auth?: boolean; user?: string },
  ) => {
    const headers = new Headers(init?.headers ?? {});
    // An explicit cookie header always wins — that is how a test replays a
    // stale or hand-made session.
    if (!headers.has("cookie") && init?.auth !== false) {
      const sid =
        init?.user === undefined
          ? TEST_SESSION_ID
          : await ensureUser(init.user);
      headers.set("cookie", `${SESSION_COOKIE}=${sid}`);
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

  /**
   * Signs someone in through the real production path (`upsertGoogleUser` +
   * `createSession`), for tests that care about the identity plumbing rather
   * than just "some authenticated caller".
   */
  const loginAs = async (email: string): Promise<TestSignIn> => {
    const user = await upsertGoogleUser(
      db,
      now(),
      { sub: `test:${email}`, email, name: null, picture: null },
      undefined,
    );
    const sessionId = await createSession(db, now(), user.id);
    return { user, sessionId, cookie: `${SESSION_COOKIE}=${sessionId}` };
  };

  const flush = async () => {
    while (waitPromises.length > 0) {
      const p = waitPromises.shift();
      if (p) await p;
    }
  };
  return { app, deps, env, request, flush, loginAs, sqlite };
}

export async function insertDigest(
  db: Deps["db"],
  overrides: {
    id?: string;
    userId?: string;
    runAt?: number;
    windowDays?: number;
    kind?: DigestKind;
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
    userId: overrides.userId ?? OWNER_USER_ID,
    runAt,
    windowDays: overrides.windowDays ?? 7,
    kind: overrides.kind ?? "weekly",
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
    /** Left null unless a test asks for it — that is what an unpersonalized run writes. */
    interestScore?: number | null;
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
    interestScore: overrides.interestScore ?? null,
    why: overrides.why ?? "Because it matters.",
    evidence: JSON.stringify(overrides.evidence ?? []),
    createdAt: overrides.createdAt ?? Date.now(),
  });
  return id;
}

/**
 * Adds a feed on top of the three rows migration 0005 already seeded. Pass
 * `enabled: false` to model the owner having turned a source off.
 */
export async function insertFeed(
  db: Deps["db"],
  overrides: {
    id?: string;
    userId?: string;
    url?: string;
    title?: string | null;
    enabled?: boolean;
    createdAt?: number;
    updatedAt?: number;
  } = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const now = overrides.createdAt ?? Date.now();
  await db.insert(feeds).values({
    id,
    userId: overrides.userId ?? OWNER_USER_ID,
    url: overrides.url ?? `https://example.com/${id}/atom.xml`,
    title: overrides.title ?? null,
    enabled: overrides.enabled ?? true,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
  return id;
}

/**
 * One user's BYOK row. No `id`: the rowid self-assigns, so several users can
 * hold settings side by side under `settings_user_uq` (migration 0012).
 */
export async function insertSettings(
  db: Deps["db"],
  overrides: {
    userId?: string;
    provider?: string;
    model?: string;
    apiKey?: string;
    cfAccountId?: string;
    cfGatewayId?: string;
    cfAigToken?: string | null;
    createdAt?: number;
    updatedAt?: number;
  } = {},
) {
  const now = overrides.createdAt ?? Date.now();
  await db.insert(settings).values({
    userId: overrides.userId ?? OWNER_USER_ID,
    provider: overrides.provider ?? "anthropic",
    model: overrides.model ?? "claude-3-5-haiku",
    apiKey: overrides.apiKey ?? "sk-test",
    cfAccountId: overrides.cfAccountId ?? "acct",
    cfGatewayId: overrides.cfGatewayId ?? "gw",
    cfAigToken: overrides.cfAigToken ?? null,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
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
    userId?: string;
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
    /** P25. Defaults to what migration 0010 gives an already-saved row. */
    contentType?: ContentType;
    /** P23 marks. Default to what migration 0009 gives an already-saved row. */
    favorite?: boolean;
    archived?: boolean;
    note?: string | null;
  } = {},
) {
  const id = overrides.id ?? crypto.randomUUID();
  const now = overrides.createdAt ?? Date.now();
  await db.insert(entries).values({
    id,
    userId: overrides.userId ?? OWNER_USER_ID,
    url: overrides.url ?? "https://example.com/a",
    canonicalUrl: overrides.canonicalUrl ?? "https://example.com/a",
    title: overrides.title ?? "T",
    summary: overrides.summary ?? "S",
    takeaway: overrides.takeaway ?? "K",
    question: overrides.question ?? "Q",
    sourceDomain: overrides.sourceDomain ?? "example.com",
    tags: JSON.stringify(overrides.tags ?? []),
    contentType: overrides.contentType ?? "article",
    favorite: overrides.favorite ?? false,
    archived: overrides.archived ?? false,
    note: overrides.note ?? null,
    status: overrides.status ?? "ready",
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now,
  });
  return id;
}
