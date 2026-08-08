import { describe, expect, it } from "vitest";
import { chats, settings as settingsTable } from "@til/db";
import { CHAT_DEFAULT_MAX_STEPS, CHAT_SEARCH_MAX_TOP_K } from "@til/core";
import {
  CHAT_TICKET_TTL_MS,
  mintChatTicket,
  verifyChatTicket,
} from "./auth.js";
import {
  CHAT_TITLE_MAX_CHARS,
  chatTitleFrom,
  parseStamp,
  toChatMessageDTO,
} from "./chat-dto.js";
import {
  CHAT_LIST_DEFAULT_LIMIT,
  CHAT_LIST_MAX_LIMIT,
  clampLimit,
  indexConversation,
  listConversations,
} from "./chat-index.js";
import {
  CHAT_MAX_SINCE_DAYS,
  CHAT_MAX_STATS_ROWS,
  CHAT_MAX_TAGS,
  CHAT_MAX_TAKEAWAY_CHARS,
  buildChatTools,
  capEntry,
  capSearchItem,
  capStatsRows,
  parseSearchArgs,
  parseStatsArgs,
} from "./chat-tools.js";
import { CHAT_NO_SETTINGS_NOTICE, chatTurnResponse } from "./chat-turn.js";
import type { ChatTool } from "@til/core";
import type { Deps } from "./deps.js";
import {
  buildTestApp,
  createRecordingChatAgents,
  insertEntry,
} from "./test-harness.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 4, 12, 0, 0);

function toolNamed(tools: ChatTool[], name: string): ChatTool {
  const found = tools.find((tool) => tool.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

async function seedSettings(deps: Deps): Promise<void> {
  await deps.db.insert(settingsTable).values({
    id: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
    cfAccountId: "acct",
    cfGatewayId: "gw",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function sse(chunks: unknown[]): Response {
  const body = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(`${body}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function toolCallSse(name: string, args: string): Response {
  return sse([
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${Math.random().toString(36).slice(2)}`,
                type: "function",
                function: { name, arguments: args },
              },
            ],
          },
        },
      ],
    },
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]);
}

function recordingFetch(respond: () => Response): {
  fetchImpl: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    bodies.push(
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : {},
    );
    return respond();
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

const userTurn = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "what about css?" }] },
];

describe("chat routes — auth", () => {
  const cases: { name: string; path: string; method?: string }[] = [
    { name: "list", path: "/api/chat" },
    { name: "messages", path: "/api/chat/c1/messages" },
    { name: "delete", path: "/api/chat/c1", method: "DELETE" },
    { name: "agent turn", path: "/api/chat/c1", method: "POST" },
    { name: "agent get-messages", path: "/api/chat/c1/get-messages" },
  ];

  for (const testCase of cases) {
    it(`401s the ${testCase.name} route without a token`, async () => {
      const t = buildTestApp();
      const res = await t.request(testCase.path, {
        auth: false,
        ...(testCase.method ? { method: testCase.method } : {}),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });
  }

  it("401s the ticket route without a token", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/chat/ticket", {
      auth: false,
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("401s a WebSocket upgrade with no credentials", async () => {
    const t = buildTestApp({ appToken: "hunter2" });
    const res = await t.request("/api/chat/c1", {
      auth: false,
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain("chat ticket");
  });

  it("401s a WebSocket upgrade carrying APP_TOKEN as the ticket", async () => {
    const t = buildTestApp({ appToken: "hunter2" });
    const res = await t.request("/api/chat/c1?ticket=hunter2", {
      auth: false,
      headers: { upgrade: "websocket" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a WebSocket upgrade with a freshly minted ticket", async () => {
    const t = buildTestApp({ appToken: "hunter2", now: () => NOW });
    const minted = await t.request("/api/chat/ticket", { method: "POST" });
    expect(minted.status).toBe(200);
    const { ticket, expiresAt } = (await minted.json()) as {
      ticket: string;
      expiresAt: number;
    };
    expect(expiresAt).toBe(NOW + CHAT_TICKET_TTL_MS);

    const res = await t.request(
      `/api/chat/c1?ticket=${encodeURIComponent(ticket)}`,
      { auth: false, headers: { upgrade: "websocket" } },
    );
    // Past auth; there is no Durable Object namespace in the test env.
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chat_unavailable");
  });

  it("never accepts a ticket on a plain HTTP request", async () => {
    const t = buildTestApp({ appToken: "hunter2", now: () => NOW });
    const minted = await t.request("/api/chat/ticket", { method: "POST" });
    const { ticket } = (await minted.json()) as { ticket: string };
    const res = await t.request(
      `/api/chat?ticket=${encodeURIComponent(ticket)}`,
      { auth: false },
    );
    expect(res.status).toBe(401);
  });

  it("never accepts APP_TOKEN from the query string", async () => {
    const t = buildTestApp({ appToken: "hunter2" });
    const res = await t.request("/api/chat?token=hunter2", { auth: false });
    expect(res.status).toBe(401);
  });

  it("does not accept a chat ticket outside /api/chat/", async () => {
    const t = buildTestApp({ appToken: "hunter2", now: () => NOW });
    const minted = await t.request("/api/chat/ticket", { method: "POST" });
    const { ticket } = (await minted.json()) as { ticket: string };
    const res = await t.request(
      `/api/entries?ticket=${encodeURIComponent(ticket)}`,
      { auth: false, headers: { upgrade: "websocket" } },
    );
    expect(res.status).toBe(401);
  });
});

describe("chat tickets", () => {
  it("verifies only inside its window", async () => {
    const { ticket, expiresAt } = await mintChatTicket("hunter2", NOW);
    await expect(verifyChatTicket("hunter2", ticket, NOW)).resolves.toBe(true);
    await expect(
      verifyChatTicket("hunter2", ticket, expiresAt - 1),
    ).resolves.toBe(true);
    await expect(verifyChatTicket("hunter2", ticket, expiresAt)).resolves.toBe(
      false,
    );
  });

  it("rejects a ticket signed with another app token", async () => {
    const { ticket } = await mintChatTicket("hunter2", NOW);
    await expect(verifyChatTicket("other", ticket, NOW)).resolves.toBe(false);
  });

  it("rejects a tampered expiry and malformed input", async () => {
    const { ticket } = await mintChatTicket("hunter2", NOW);
    const signature = ticket.slice(ticket.indexOf(".") + 1);
    // Still inside the accepted window, so only the signature can reject it.
    const moved = NOW + CHAT_TICKET_TTL_MS - 1;
    await expect(
      verifyChatTicket("hunter2", `${moved}.${signature}`, NOW),
    ).resolves.toBe(false);
    for (const bad of ["", ".", "abc", `${NOW}.`, "999.zzz"]) {
      await expect(verifyChatTicket("hunter2", bad, NOW)).resolves.toBe(false);
    }
  });

  it("refuses a ticket minted against a far-future clock", async () => {
    const { ticket } = await mintChatTicket("hunter2", NOW + 10 * 60_000);
    await expect(verifyChatTicket("hunter2", ticket, NOW)).resolves.toBe(false);
  });
});

describe("chat tool arguments", () => {
  it("clamps topK above the ceiling instead of rejecting", () => {
    expect(parseSearchArgs({ query: "css", topK: 999 }).topK).toBe(
      CHAT_SEARCH_MAX_TOP_K,
    );
    expect(parseSearchArgs({ query: "css", topK: 0 }).topK).toBe(1);
    expect(parseSearchArgs({ query: "css", topK: -4 }).topK).toBe(1);
    expect(parseSearchArgs({ query: "css", topK: 3.9 }).topK).toBe(3);
  });

  it("falls back to the default topK when it is missing or unusable", () => {
    expect(parseSearchArgs({ query: "css" }).topK).toBe(8);
    expect(parseSearchArgs({ query: "css", topK: "lots" }).topK).toBe(8);
  });

  it("drops a non-positive sinceDays and bounds a huge one", () => {
    expect(parseSearchArgs({ query: "css", sinceDays: -5 }).sinceDays).toBe(1);
    expect(parseSearchArgs({ query: "css", sinceDays: 999999 }).sinceDays).toBe(
      CHAT_MAX_SINCE_DAYS,
    );
    expect(parseSearchArgs({ query: "css" }).sinceDays).toBeUndefined();
  });

  it("rejects an empty query", () => {
    expect(() => parseSearchArgs({ query: "" })).toThrow();
    expect(() => parseSearchArgs({})).toThrow();
  });

  it("rejects a stats kind outside the contract", () => {
    expect(parseStatsArgs({ kind: "totals" }).kind).toBe("totals");
    expect(() => parseStatsArgs({ kind: "everything" })).toThrow();
    expect(() => parseStatsArgs({})).toThrow();
  });

  it("bounds sinceDays on stats too", () => {
    expect(parseStatsArgs({ kind: "per_week", sinceDays: -1 }).sinceDays).toBe(1);
    expect(
      parseStatsArgs({ kind: "per_week", sinceDays: 10_000 }).sinceDays,
    ).toBe(CHAT_MAX_SINCE_DAYS);
  });
});

describe("chat tool result caps", () => {
  it("keeps only the contract fields of a search item", () => {
    const capped = capSearchItem({
      id: "e1",
      title: "T",
      url: "https://example.com/a",
      sourceDomain: "example.com",
      takeaway: "K",
      tags: ["a"],
      createdAt: 1,
      score: 0.5,
      // @ts-expect-error deliberately over-wide input: the cap must drop extras
      contentMarkdown: "the whole article",
    });
    expect(Object.keys(capped).sort()).toEqual([
      "createdAt",
      "id",
      "score",
      "sourceDomain",
      "tags",
      "takeaway",
      "title",
      "url",
    ]);
  });

  it("truncates long text and trims the tag list", () => {
    const capped = capSearchItem({
      id: "e1",
      title: "T",
      url: "https://example.com/a",
      sourceDomain: "example.com",
      takeaway: "x".repeat(5000),
      tags: Array.from({ length: 30 }, (_, i) => `t${i}`),
      createdAt: 1,
      score: 0.5,
    });
    expect(capped.takeaway).toHaveLength(CHAT_MAX_TAKEAWAY_CHARS + 1);
    expect(capped.takeaway?.endsWith("…")).toBe(true);
    expect(capped.tags).toHaveLength(CHAT_MAX_TAGS);
  });

  it("truncates the entry summary", () => {
    const capped = capEntry({
      id: "e1",
      title: null,
      url: "https://example.com/a",
      summary: "y".repeat(9000),
      takeaway: null,
      question: null,
      tags: [],
      createdAt: 1,
    });
    expect(capped.summary?.length).toBeLessThan(2000);
  });

  it("caps the number of stats rows", () => {
    const rows = Array.from({ length: 500 }, (_, i) => ({ week: `w${i}` }));
    expect(capStatsRows(rows)).toHaveLength(CHAT_MAX_STATS_ROWS);
  });
});

describe("chat tool wiring", () => {
  async function seedCorpus() {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < 25; i += 1) {
      await insertEntry(t.deps.db, {
        id: `k-${i}`,
        url: `https://example.com/k-${i}`,
        canonicalUrl: `https://example.com/k-${i}`,
        title: `Kubernetes note ${i}`,
        takeaway: "kubernetes scheduling notes",
        tags: ["kubernetes"],
        sourceDomain: "example.com",
        createdAt: NOW - i * DAY,
      });
    }
    return t;
  }

  it("clamps topK all the way through to searchEntries", async () => {
    const t = await seedCorpus();
    const tools = buildChatTools(t.deps);
    const out = (await toolNamed(tools, "search_entries").execute({
      query: "kubernetes",
      topK: 999,
    })) as { items: unknown[] };
    expect(out.items).toHaveLength(CHAT_SEARCH_MAX_TOP_K);
  });

  it("passes the recency window through to searchEntries", async () => {
    const t = await seedCorpus();
    const tools = buildChatTools(t.deps);
    const out = (await toolNamed(tools, "search_entries").execute({
      query: "kubernetes",
      topK: 20,
      sinceDays: 3,
    })) as { items: { id: string }[] };
    // The cutoff is inclusive, so exactly the entries at 0..3 days old.
    expect(out.items.map((i) => i.id).sort()).toEqual([
      "k-0",
      "k-1",
      "k-2",
      "k-3",
    ]);
  });

  it("caps the takeaway that searchEntries returned", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "long",
      takeaway: `kubernetes ${"z".repeat(5000)}`,
      createdAt: NOW,
    });
    const tools = buildChatTools(t.deps);
    const out = (await toolNamed(tools, "search_entries").execute({
      query: "kubernetes",
    })) as { items: { takeaway: string }[] };
    expect(out.items[0]!.takeaway).toHaveLength(CHAT_MAX_TAKEAWAY_CHARS + 1);
  });

  it("returns one entry by id and null for an unknown id", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, { id: "e1", title: "Known", createdAt: NOW });
    const tools = buildChatTools(t.deps);
    const found = (await toolNamed(tools, "get_entry").execute({
      id: "e1",
    })) as { entry: { id: string; title: string } | null };
    expect(found.entry?.title).toBe("Known");
    const missing = (await toolNamed(tools, "get_entry").execute({
      id: "nope",
    })) as { entry: unknown };
    expect(missing.entry).toBeNull();
  });

  it("computes the requested aggregate", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, { id: "e1", createdAt: NOW });
    await insertEntry(t.deps.db, {
      id: "e2",
      url: "https://example.com/b",
      canonicalUrl: "https://example.com/b",
      createdAt: NOW,
    });
    const tools = buildChatTools(t.deps);
    const out = (await toolNamed(tools, "stats").execute({
      kind: "totals",
    })) as { kind: string; rows: { entries: number }[] };
    expect(out.kind).toBe("totals");
    expect(out.rows[0]!.entries).toBe(2);
  });

  it("rejects a bogus stats kind before touching the database", async () => {
    const t = buildTestApp({ now: () => NOW });
    const tools = buildChatTools(t.deps);
    await expect(
      toolNamed(tools, "stats").execute({ kind: "vibes" }),
    ).rejects.toThrow();
  });

  it("exposes exactly the three read-only tools with their JSON Schemas", () => {
    const t = buildTestApp();
    const tools = buildChatTools(t.deps);
    expect(tools.map((tool) => tool.name)).toEqual([
      "search_entries",
      "get_entry",
      "stats",
    ]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
    }
  });
});

describe("chat turn", () => {
  it("answers with a readable notice when no settings are saved", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await chatTurnResponse(t.deps, {
      conversationId: "c1",
      messages: userTurn,
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain("no LLM provider is configured");
    expect(CHAT_NO_SETTINGS_NOTICE).toContain("Open Settings");
  });

  it("indexes the conversation even when it cannot answer", async () => {
    const t = buildTestApp({ now: () => NOW });
    await (
      await chatTurnResponse(t.deps, {
        conversationId: "c1",
        messages: userTurn,
      })
    ).text();
    const rows = await t.deps.db.select().from(chats);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "c1",
      title: "what about css?",
      messageCount: 1,
    });
  });

  it("streams through the gateway with the tools attached", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedSettings(t.deps);
    const { fetchImpl, bodies } = recordingFetch(() =>
      sse([
        {
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: { content: "nothing saved" } }],
        },
        {
          id: "c1",
          object: "chat.completion.chunk",
          created: 0,
          model: "gpt-4o-mini",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        },
      ]),
    );
    const withFetch: Deps = { ...t.deps, fetchImpl };
    const body = await (
      await chatTurnResponse(withFetch, {
        conversationId: "c1",
        messages: userTurn,
      })
    ).text();

    expect(bodies).toHaveLength(1);
    const tools = bodies[0]!.tools as { function: { name: string } }[];
    expect(tools.map((tool) => tool.function.name)).toEqual([
      "search_entries",
      "get_entry",
      "stats",
    ]);
    expect(body).toContain("nothing saved");
  });

  it("bounds the tool loop at CHAT_DEFAULT_MAX_STEPS", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedSettings(t.deps);
    await insertEntry(t.deps.db, {
      id: "e1",
      takeaway: "kubernetes notes",
      createdAt: NOW,
    });
    const { fetchImpl, bodies } = recordingFetch(() =>
      toolCallSse("search_entries", '{"query":"kubernetes","topK":999}'),
    );
    const withFetch: Deps = { ...t.deps, fetchImpl };
    await (
      await chatTurnResponse(withFetch, {
        conversationId: "c1",
        messages: userTurn,
      })
    ).text();
    expect(bodies).toHaveLength(CHAT_DEFAULT_MAX_STEPS);
  });

  it("honours an explicit maxSteps", async () => {
    const t = buildTestApp({ now: () => NOW });
    await seedSettings(t.deps);
    const { fetchImpl, bodies } = recordingFetch(() =>
      toolCallSse("stats", '{"kind":"totals"}'),
    );
    const withFetch: Deps = { ...t.deps, fetchImpl };
    await (
      await chatTurnResponse(withFetch, {
        conversationId: "c1",
        messages: userTurn,
        maxSteps: 2,
      })
    ).text();
    expect(bodies).toHaveLength(2);
  });
});

describe("ChatMessageDTO mapping", () => {
  it("joins text parts and keeps tool calls with their args and result", () => {
    const dto = toChatMessageDTO(
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "step-start" },
          {
            type: "tool-search_entries",
            toolCallId: "call_1",
            toolName: "search_entries",
            state: "output-available",
            input: { query: "css", topK: 8 },
            output: { items: [] },
          },
          { type: "text", text: "Nothing about css." },
          { type: "text", text: "Try a different word." },
        ],
      },
      1_700_000_000_000,
    );
    expect(dto).toEqual({
      id: "a1",
      role: "assistant",
      content: "Nothing about css.\nTry a different word.",
      toolCalls: [
        {
          name: "search_entries",
          args: { query: "css", topK: 8 },
          result: { items: [] },
        },
      ],
      createdAt: 1_700_000_000_000,
    });
  });

  it("omits toolCalls entirely for a plain turn", () => {
    const dto = toChatMessageDTO(
      { id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] },
      5,
    );
    expect(dto).toEqual({ id: "m1", role: "user", content: "hi", createdAt: 5 });
    expect(dto && "toolCalls" in dto).toBe(false);
  });

  it("records a tool call that has no result yet", () => {
    const dto = toChatMessageDTO(
      {
        id: "a1",
        role: "assistant",
        parts: [
          {
            type: "tool-stats",
            toolName: "stats",
            state: "input-available",
            input: { kind: "totals" },
          },
        ],
      },
      0,
    );
    expect(dto?.toolCalls).toEqual([
      { name: "stats", args: { kind: "totals" } },
    ]);
  });

  it("falls back to the part type when toolName is absent", () => {
    const dto = toChatMessageDTO(
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "tool-get_entry", input: { id: "e1" } }],
      },
      0,
    );
    expect(dto?.toolCalls?.[0]?.name).toBe("get_entry");
  });

  it("reads a client-side dynamic tool part", () => {
    const dto = toChatMessageDTO(
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "dynamic-tool", toolName: "getLocation", input: {}, output: 1 },
        ],
      },
      0,
    );
    expect(dto?.toolCalls).toEqual([
      { name: "getLocation", args: {}, result: 1 },
    ]);
  });

  it("drops rows that are not a user or assistant turn", () => {
    expect(toChatMessageDTO(null, 0)).toBeNull();
    expect(toChatMessageDTO({ id: "s", role: "system", parts: [] }, 0)).toBeNull();
    expect(toChatMessageDTO({ role: "user", parts: [] }, 0)).toBeNull();
  });
});

describe("conversation titles and timestamps", () => {
  it("collapses whitespace and truncates long titles", () => {
    expect(chatTitleFrom("  what   about\ncss? ")).toBe("what about css?");
    expect(chatTitleFrom("")).toBeNull();
    const long = chatTitleFrom("q".repeat(500));
    expect(long).toHaveLength(CHAT_TITLE_MAX_CHARS + 1);
  });

  it("reads SQLite's UTC current_timestamp format", () => {
    expect(parseStamp("2026-08-08 10:33:12")).toBe(
      Date.UTC(2026, 7, 8, 10, 33, 12),
    );
    expect(parseStamp(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(parseStamp(null)).toBe(0);
    expect(parseStamp("not a date")).toBe(0);
  });
});

describe("conversation index", () => {
  it("keeps the first title and refreshes count and updatedAt", async () => {
    let clock = NOW;
    const t = buildTestApp({ now: () => clock });
    await indexConversation(t.deps, "c1", { title: "First question", messageCount: 1 });
    clock = NOW + 60_000;
    await indexConversation(t.deps, "c1", { title: "Later question", messageCount: 4 });

    const rows = await t.deps.db.select().from(chats);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "c1",
      title: "First question",
      messageCount: 4,
      createdAt: NOW,
      updatedAt: NOW + 60_000,
    });
  });

  it("clamps the list limit", () => {
    expect(clampLimit(undefined)).toBe(CHAT_LIST_DEFAULT_LIMIT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(10_000)).toBe(CHAT_LIST_MAX_LIMIT);
    expect(clampLimit(Number.NaN)).toBe(CHAT_LIST_DEFAULT_LIMIT);
  });

  it("lists conversations newest-updated first", async () => {
    let clock = NOW;
    const t = buildTestApp({ now: () => clock });
    await indexConversation(t.deps, "old", { title: "old", messageCount: 2 });
    clock = NOW + 1000;
    await indexConversation(t.deps, "new", { title: "new", messageCount: 6 });

    const listed = await listConversations(t.deps);
    expect(listed.map((row) => row.id)).toEqual(["new", "old"]);
    expect(listed[0]).toEqual({
      id: "new",
      title: "new",
      updatedAt: NOW + 1000,
      messageCount: 6,
    });
  });
});

describe("chat REST routes", () => {
  it("lists conversations", async () => {
    const t = buildTestApp({ now: () => NOW });
    await indexConversation(t.deps, "c1", { title: "About css", messageCount: 3 });
    const res = await t.request("/api/chat");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [{ id: "c1", title: "About css", updatedAt: NOW, messageCount: 3 }],
    });
  });

  it("honours the list limit", async () => {
    const t = buildTestApp({ now: () => NOW });
    for (let i = 0; i < 5; i += 1) {
      await indexConversation(t.deps, `c${i}`, { title: `c${i}`, messageCount: 1 });
    }
    const res = await t.request("/api/chat?limit=2");
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(2);
  });

  it("returns an empty list when nothing has been asked yet", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/chat");
    expect(await res.json()).toEqual({ items: [] });
  });

  it("returns the transcript from the agent", async () => {
    const chatAgents = createRecordingChatAgents();
    chatAgents.messages.set("c1", [
      { id: "m1", role: "user", content: "hi", createdAt: 1 },
      {
        id: "a1",
        role: "assistant",
        content: "hello",
        toolCalls: [{ name: "stats", args: { kind: "totals" }, result: {} }],
        createdAt: 2,
      },
    ]);
    const t = buildTestApp({ chatAgents: chatAgents.binding });
    const res = await t.request("/api/chat/c1/messages");
    expect(res.status).toBe(200);
    expect(chatAgents.opened).toEqual(["c1"]);
    const body = (await res.json()) as { messages: { id: string }[] };
    expect(body.messages.map((m) => m.id)).toEqual(["m1", "a1"]);
  });

  it("deletes the transcript and the index row", async () => {
    const chatAgents = createRecordingChatAgents();
    const t = buildTestApp({ now: () => NOW, chatAgents: chatAgents.binding });
    await indexConversation(t.deps, "c1", { title: "About css", messageCount: 3 });
    await indexConversation(t.deps, "c2", { title: "Other", messageCount: 1 });

    const res = await t.request("/api/chat/c1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(chatAgents.cleared).toEqual(["c1"]);
    const remaining = await t.deps.db.select({ id: chats.id }).from(chats);
    expect(remaining.map((row) => row.id)).toEqual(["c2"]);
  });

  it("deleting an unknown conversation is idempotent", async () => {
    const chatAgents = createRecordingChatAgents();
    const t = buildTestApp({ chatAgents: chatAgents.binding });
    const res = await t.request("/api/chat/never-existed", { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  it("hands the agent's own paths to the binding, unchanged", async () => {
    const chatAgents = createRecordingChatAgents({
      route: () => new Response("[]", { status: 200 }),
    });
    const t = buildTestApp({ chatAgents: chatAgents.binding });

    const turn = await t.request("/api/chat/c1", { method: "POST" });
    expect(turn.status).toBe(200);
    const fetched = await t.request("/api/chat/c1/get-messages");
    expect(fetched.status).toBe(200);

    expect(chatAgents.routed.map((req) => new URL(req.url).pathname)).toEqual([
      "/api/chat/c1",
      "/api/chat/c1/get-messages",
    ]);
    // The REST endpoints must not be swallowed by the catch-all.
    expect(chatAgents.opened).toEqual([]);
  });

  it("503s the transcript and delete routes without the CHAT binding", async () => {
    const t = buildTestApp({ chatAgents: null });
    const messages = await t.request("/api/chat/c1/messages");
    expect(messages.status).toBe(503);
    const removed = await t.request("/api/chat/c1", { method: "DELETE" });
    expect(removed.status).toBe(503);
    const body = (await removed.json()) as { error: { code: string } };
    expect(body.error.code).toBe("chat_unavailable");
  });
});
