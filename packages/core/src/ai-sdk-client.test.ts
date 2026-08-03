import { describe, expect, it } from "vitest";
import { AISDKClient } from "./ai-sdk-client.js";
import { DigestError } from "./errors.js";
import type { LLMSettings, SynthesisInput } from "./types.js";

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(
  respond: (req: Captured) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const rawHeaders: Record<string, string> = {};
    const hdrs = init?.headers;
    if (hdrs instanceof Headers) {
      hdrs.forEach((v, k) => {
        rawHeaders[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(hdrs)) {
      for (const [k, v] of hdrs) rawHeaders[k.toLowerCase()] = v;
    } else if (hdrs) {
      for (const [k, v] of Object.entries(hdrs as Record<string, string>)) {
        rawHeaders[k.toLowerCase()] = v;
      }
    }
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const req: Captured = {
      url: typeof input === "string" ? input : input.toString(),
      headers: rawHeaders,
      body,
    };
    captured.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const openaiSettings: LLMSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  cfAccountId: "acct",
  cfGatewayId: "gw",
};

const anthropicSettings: LLMSettings = {
  provider: "anthropic",
  model: "claude-3-5-sonnet-20241022",
  apiKey: "sk-ant",
  cfAccountId: "acct",
  cfGatewayId: "gw",
};

const groqSettings: LLMSettings = {
  provider: "groq",
  model: "llama-3.3-70b-versatile",
  apiKey: "gsk-test",
  cfAccountId: "acct",
  cfGatewayId: "gw",
};

const validDigest = {
  title: "Rust ownership rules",
  summary: "A short summary of ownership in Rust.",
  takeaway: "Ownership prevents most memory bugs at compile time.",
  question: "How does this compare to C++'s RAII?",
  tags: ["rust", "memory-safety", "systems-programming"],
};

function openaiChatOk(digest: unknown): Response {
  return jsonResponse({
    id: "cmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: JSON.stringify(digest) },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

function anthropicMessagesOk(digest: unknown): Response {
  return jsonResponse({
    id: "msg-test",
    type: "message",
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id: "toolu_1",
        name: "json",
        input: digest,
      },
    ],
    model: "claude-3-5-sonnet-20241022",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

describe("AISDKClient — OpenAI", () => {
  it("sends chat.completions request through the gateway", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiChatOk(validDigest));
    const client = new AISDKClient(openaiSettings, fetchImpl);
    const digest = await client.digest("hello world", {
      url: "https://example.com",
      title: "Ex",
    });
    expect(digest).toEqual(validDigest);
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer sk-test");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-mini");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe("system");
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiChatOk(validDigest));
    const client = new AISDKClient(
      { ...openaiSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hi", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError on malformed digest (bad tags)", async () => {
    const bad = { ...validDigest, tags: ["only-one"] };
    const { fetchImpl } = makeFetch(() => openaiChatOk(bad));
    const client = new AISDKClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new AISDKClient(openaiSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe("string");
  });
});

describe("AISDKClient — Anthropic", () => {
  it("sends messages request through the gateway", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicMessagesOk(validDigest),
    );
    const client = new AISDKClient(anthropicSettings, fetchImpl);
    const digest = await client.digest("hello world", {
      url: "https://example.com",
    });
    expect(digest).toEqual(validDigest);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBeDefined();
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicMessagesOk(validDigest),
    );
    const client = new AISDKClient(
      { ...anthropicSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hi", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError when tool input is missing a required field", async () => {
    const bad = { ...validDigest, title: undefined };
    const { fetchImpl } = makeFetch(() => anthropicMessagesOk(bad));
    const client = new AISDKClient(anthropicSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "authentication_error", message: "bad key" },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new AISDKClient(anthropicSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
  });
});

describe("AISDKClient — Groq", () => {
  it("sends chat.completions request through the gateway", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiChatOk(validDigest));
    const client = new AISDKClient(groqSettings, fetchImpl);
    const digest = await client.digest("hello world", {
      url: "https://example.com",
      title: "Ex",
    });
    expect(digest).toEqual(validDigest);
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    // The groq provider default appends `/chat/completions` to the baseURL.
    // We pass `…/groq` (no `/openai/v1`), so the final URL must be
    // `…/groq/chat/completions`.
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/groq/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer gsk-test");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("llama-3.3-70b-versatile");
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    expect(messages[0]!.role).toBe("system");
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiChatOk(validDigest));
    const client = new AISDKClient(
      { ...groqSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hi", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("uses json_object mode with the schema in the prompt, never json_schema", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiChatOk(validDigest));
    const client = new AISDKClient(groqSettings, fetchImpl);
    await client.digest("hello world", { url: "https://example.com" });

    const body = captured[0]!.body as Record<string, unknown>;
    const responseFormat = body.response_format as
      | { type?: string }
      | undefined;
    expect(responseFormat?.type).not.toBe("json_schema");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("JSON");
    expect(messages[0]!.content).toContain("takeaway");
  });

  it("throws DigestError on malformed digest (bad tags)", async () => {
    const bad = { ...validDigest, tags: ["only-one"] };
    const { fetchImpl } = makeFetch(() => openaiChatOk(bad));
    const client = new AISDKClient(groqSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({ error: { message: "Unauthorized" } }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    const client = new AISDKClient(groqSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(typeof result.detail).toBe("string");
  });
});

const synthesisInputs: SynthesisInput[] = [
  {
    canonicalUrl: "https://a.example/one",
    title: "A tiny type checker",
    sources: ["hackernews"],
    publishedAt: 1_700_000_000_000,
    score: 0.9,
    snippet: "A 500-line inference engine.",
  },
  {
    canonicalUrl: "https://b.example/two",
    title: "Lobsters weekly",
    sources: ["lobsters", "hackernews"],
    publishedAt: 1_699_000_000_000,
    score: 0.5,
  },
];

const synthesisOpts = { windowDays: 7, maxItems: 2 };

const validSynthesis = {
  title: "This week in compilers",
  intro: "Two things worth reading. Both are short.",
  items: [
    {
      canonicalUrl: "https://a.example/one",
      title: "A tiny type checker",
      why: "It fits in one file.",
    },
    {
      canonicalUrl: "https://b.example/two",
      title: "Lobsters weekly",
      why: "Good roundup.",
    },
  ],
};

describe("AISDKClient — OpenAI synthesis", () => {
  it("sends chat.completions with a json_schema response format", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      openaiChatOk(validSynthesis),
    );
    const client = new AISDKClient(openaiSettings, fetchImpl);
    const result = await client.synthesizeDigest(
      synthesisInputs,
      synthesisOpts,
    );
    expect(result).toEqual(validSynthesis);

    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/openai/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer sk-test");

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-mini");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("UNTRUSTED DATA");
    expect(messages[1]!.content).toContain("<candidates>");
    expect(messages[1]!.content).toContain("https://a.example/one");
    const rf = body.response_format as { type?: string } | undefined;
    expect(rf?.type).toBe("json_schema");
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      openaiChatOk(validSynthesis),
    );
    const client = new AISDKClient(
      { ...openaiSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });
});

describe("AISDKClient — Anthropic synthesis", () => {
  it("sends the messages request through the gateway", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicMessagesOk(validSynthesis),
    );
    const client = new AISDKClient(anthropicSettings, fetchImpl);
    const result = await client.synthesizeDigest(
      synthesisInputs,
      synthesisOpts,
    );
    expect(result).toEqual(validSynthesis);

    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
    expect(req.headers["x-api-key"]).toBe("sk-ant");

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(JSON.stringify(body.system)).toContain("UNTRUSTED DATA");
    const tools = body.tools as Array<Record<string, unknown>> | undefined;
    expect(tools?.length).toBeGreaterThan(0);
    expect(body.tool_choice).toBeDefined();
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicMessagesOk(validSynthesis),
    );
    const client = new AISDKClient(
      { ...anthropicSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });
});

describe("AISDKClient — Groq synthesis", () => {
  it("uses json_object mode with the schema in the prompt, never json_schema", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      openaiChatOk(validSynthesis),
    );
    const client = new AISDKClient(groqSettings, fetchImpl);
    const result = await client.synthesizeDigest(
      synthesisInputs,
      synthesisOpts,
    );
    expect(result).toEqual(validSynthesis);

    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/groq/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer gsk-test");

    const body = req.body as Record<string, unknown>;
    const rf = body.response_format as { type?: string } | undefined;
    expect(rf?.type).not.toBe("json_schema");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("UNTRUSTED DATA");
    expect(messages[0]!.content).toContain("JSON");
    expect(messages[0]!.content).toContain("canonicalUrl");
    expect(messages[1]!.content).toContain("<candidates>");
  });

  it("sends cf-aig-authorization when token is set", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      openaiChatOk(validSynthesis),
    );
    const client = new AISDKClient(
      { ...groqSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });
});

interface SynthesisDialect {
  label: string;
  settings: LLMSettings;
  ok: (payload: unknown) => Response;
  nonJson: () => Response;
}

const synthesisDialects: SynthesisDialect[] = [
  {
    label: "OpenAI",
    settings: openaiSettings,
    ok: openaiChatOk,
    nonJson: () => openaiChatOkRaw("not json"),
  },
  {
    label: "Anthropic",
    settings: anthropicSettings,
    ok: anthropicMessagesOk,
    nonJson: () => new Response("<html>gateway error</html>", { status: 200 }),
  },
  {
    label: "Groq",
    settings: groqSettings,
    ok: openaiChatOk,
    nonJson: () => openaiChatOkRaw("not json"),
  },
];

function openaiChatOkRaw(content: string): Response {
  return jsonResponse({
    id: "cmpl-test",
    object: "chat.completion",
    created: 0,
    model: "gpt-4o-mini",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

for (const dialect of synthesisDialects) {
  describe(`AISDKClient — ${dialect.label} synthesis validation`, () => {
    const run = (payload: unknown, maxItems = synthesisOpts.maxItems) => {
      const { fetchImpl } = makeFetch(() => dialect.ok(payload));
      const client = new AISDKClient(dialect.settings, fetchImpl);
      return client.synthesizeDigest(synthesisInputs, {
        ...synthesisOpts,
        maxItems,
      });
    };

    it("drops items whose canonicalUrl is not in inputs", async () => {
      const result = await run({
        ...validSynthesis,
        items: [
          {
            canonicalUrl: "https://evil.example/invented",
            title: "Invented",
            why: "Nope.",
          },
          ...validSynthesis.items,
        ],
      });
      expect(result.items.map((item) => item.canonicalUrl)).toEqual([
        "https://a.example/one",
        "https://b.example/two",
      ]);
    });

    it("truncates items to maxItems", async () => {
      const result = await run(validSynthesis, 1);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.canonicalUrl).toBe("https://a.example/one");
    });

    it("collapses duplicate urls", async () => {
      const result = await run({
        ...validSynthesis,
        items: [
          validSynthesis.items[0]!,
          { ...validSynthesis.items[0]!, why: "Second take." },
          validSynthesis.items[1]!,
        ],
      });
      expect(result.items).toHaveLength(2);
      expect(result.items[0]!.why).toBe("It fits in one file.");
    });

    it("throws DigestError when title is missing", async () => {
      await expect(
        run({ ...validSynthesis, title: undefined }),
      ).rejects.toThrow(DigestError);
    });

    it("throws DigestError when intro is missing", async () => {
      await expect(
        run({ ...validSynthesis, intro: undefined }),
      ).rejects.toThrow(DigestError);
    });

    it("throws DigestError when the body is not usable JSON", async () => {
      const { fetchImpl } = makeFetch(() => dialect.nonJson());
      const client = new AISDKClient(dialect.settings, fetchImpl);
      await expect(
        client.synthesizeDigest(synthesisInputs, synthesisOpts),
      ).rejects.toThrow(DigestError);
    });
  });
}
