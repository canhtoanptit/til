import { describe, expect, it } from "vitest";
import { CHAT_SYSTEM_PROMPT, CHAT_TOOL_SCHEMAS } from "./chat.js";
import {
  CHAT_DEFAULT_MAX_STEPS,
  chatNoticeResponse,
  streamChat,
  type ChatTool,
} from "./chat-stream.js";
import type { LLMSettings } from "./types.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function makeFetch(responses: Response[]): {
  fetchImpl: typeof fetch;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: Request | string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw instanceof Headers) {
      raw.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(raw)) {
      for (const [k, v] of raw) headers[k.toLowerCase()] = v;
    } else if (raw) {
      for (const [k, v] of Object.entries(raw as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
    let body: Record<string, unknown> = {};
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    captured.push({
      url: typeof input === "string" ? input : input.toString(),
      headers,
      body,
    });
    const next = queue.shift();
    if (!next) throw new Error("unexpected extra provider request");
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function sse(chunks: unknown[]): Response {
  const lines = chunks
    .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
    .join("");
  return new Response(`${lines}data: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function textChunks(text: string): unknown[] {
  return [
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: { role: "assistant", content: text } }],
    },
    {
      id: "c1",
      object: "chat.completion.chunk",
      created: 0,
      model: "gpt-4o-mini",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
  ];
}

function toolCallChunks(name: string, args: string): unknown[] {
  return [
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
                id: "call_1",
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
  ];
}

const settings: LLMSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  cfAccountId: "acct",
  cfGatewayId: "gw",
};

const messages = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "what about css?" }] },
];

function searchTool(calls: Record<string, unknown>[]): ChatTool {
  return {
    name: "search_entries",
    description: "Search the saved entries.",
    inputSchema: CHAT_TOOL_SCHEMAS.search_entries,
    execute: async (args) => {
      calls.push(args);
      return { items: [] };
    },
  };
}

// WHY: streamText is lazy — the provider is not called until the returned
// UI-message stream is drained, so every assertion on `captured` must read first.
async function readBody(res: Response): Promise<string> {
  return await res.text();
}

describe("streamChat", () => {
  it("posts to the CF AI Gateway with the provider key and streams back", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("hi there"))]);
    const res = await streamChat({
      settings,
      messages,
      tools: [],
      fetchImpl,
    });

    expect(res).toBeInstanceOf(Response);
    const body = await readBody(res);

    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer sk-test");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();
    expect(req.body.stream).toBe(true);
    expect(body).toContain("text-delta");
    expect(body).toContain("hi there");
  });

  it("sends cf-aig-authorization when the gateway token is set", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("ok"))]);
    const res = await streamChat({
      settings: { ...settings, cfAigToken: "gw-token" },
      messages,
      tools: [],
      fetchImpl,
    });
    await readBody(res);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("includes the chat system prompt and the user turn", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("ok"))]);
    await readBody(await streamChat({ settings, messages, tools: [], fetchImpl }));

    const wire = captured[0]!.body.messages as {
      role: string;
      content: unknown;
    }[];
    expect(wire[0]!.role).toBe("system");
    expect(wire[0]!.content).toBe(CHAT_SYSTEM_PROMPT);
    expect(wire[1]!.role).toBe("user");
    expect(JSON.stringify(wire[1]!.content)).toContain("what about css?");
  });

  it("sends the tools with their JSON Schema and descriptions", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("ok"))]);
    await readBody(
      await streamChat({
        settings,
        messages,
        tools: [searchTool([])],
        fetchImpl,
      }),
    );

    const tools = captured[0]!.body.tools as {
      type: string;
      function: { name: string; description: string; parameters: unknown };
    }[];
    expect(tools).toHaveLength(1);
    expect(tools[0]!.function.name).toBe("search_entries");
    expect(tools[0]!.function.description).toBe("Search the saved entries.");
    expect(tools[0]!.function.parameters).toMatchObject({
      type: "object",
      required: ["query"],
    });
  });

  it("runs a tool call and feeds the result back to the model", async () => {
    const calls: Record<string, unknown>[] = [];
    const { fetchImpl, captured } = makeFetch([
      sse(toolCallChunks("search_entries", '{"query":"css"}')),
      sse(textChunks("nothing saved about css")),
    ]);
    const res = await streamChat({
      settings,
      messages,
      tools: [searchTool(calls)],
      fetchImpl,
    });
    const body = await readBody(res);

    expect(calls).toEqual([{ query: "css" }]);
    expect(captured).toHaveLength(2);
    expect(body).toContain("tool-output-available");
    expect(body).toContain("nothing saved about css");
  });

  it("stops the tool loop at maxSteps", async () => {
    const calls: Record<string, unknown>[] = [];
    const { fetchImpl, captured } = makeFetch([
      sse(toolCallChunks("search_entries", '{"query":"css"}')),
    ]);
    const res = await streamChat({
      settings,
      messages,
      tools: [searchTool(calls)],
      maxSteps: 1,
      fetchImpl,
    });
    await readBody(res);

    // One step: the tool ran, but the model was never called a second time.
    expect(calls).toHaveLength(1);
    expect(captured).toHaveLength(1);
  });

  it("defaults the step bound to CHAT_DEFAULT_MAX_STEPS", async () => {
    const calls: Record<string, unknown>[] = [];
    const { fetchImpl, captured } = makeFetch(
      Array.from({ length: CHAT_DEFAULT_MAX_STEPS }, () =>
        sse(toolCallChunks("search_entries", '{"query":"css"}')),
      ),
    );
    const res = await streamChat({
      settings,
      messages,
      tools: [searchTool(calls)],
      fetchImpl,
    });
    await readBody(res);

    expect(CHAT_DEFAULT_MAX_STEPS).toBe(6);
    expect(captured).toHaveLength(CHAT_DEFAULT_MAX_STEPS);
  });

  it("drops transcript entries that are not UI messages", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("ok"))]);
    await readBody(
      await streamChat({
        settings,
        messages: [null, "nope", 7, { parts: [] }, ...messages],
        tools: [],
        fetchImpl,
      }),
    );
    const wire = captured[0]!.body.messages as { role: string }[];
    expect(wire.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("never calls the provider when the transcript is unusable", async () => {
    const { fetchImpl, captured } = makeFetch([sse(textChunks("ok"))]);
    const res = await streamChat({
      settings,
      messages: null,
      tools: [],
      fetchImpl,
    });
    const body = await readBody(res);
    expect(captured).toHaveLength(0);
    expect(body).toContain('"type":"error"');
  });
});

describe("chatNoticeResponse", () => {
  it("emits a readable assistant turn in the UI message stream format", async () => {
    const res = chatNoticeResponse("No model is configured yet.");
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('"type":"start"');
    expect(body).toContain('"type":"text-delta"');
    expect(body).toContain("No model is configured yet.");
    expect(body).toContain('"type":"finish"');
  });
});
