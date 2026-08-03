import { describe, expect, it } from "vitest";
import { DigestError } from "./errors.js";
import { DirectLLMClient } from "./direct-client.js";
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
    const rawHeaders = init?.headers ?? {};
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    let body: unknown = null;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    const req: Captured = {
      url: typeof input === "string" ? input : input.toString(),
      headers,
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

function openaiOk(digest: unknown): Response {
  return jsonResponse({
    choices: [{ message: { content: JSON.stringify(digest) } }],
  });
}

function anthropicOk(digest: unknown): Response {
  return jsonResponse({
    content: [
      { type: "tool_use", name: "record_digest", input: digest },
    ],
  });
}

describe("DirectLLMClient — OpenAI", () => {
  it("sends the correct URL, headers, and body shape", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validDigest));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    const digest = await client.digest("hello", {
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
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("gpt-4o-mini");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("URL: https://example.com");
    expect(messages[1]!.content).toContain("Title: Ex");
    expect(messages[1]!.content).toContain("<article>");
    const rf = body.response_format as Record<string, unknown>;
    expect(rf.type).toBe("json_schema");
    const js = rf.json_schema as Record<string, unknown>;
    expect(js.name).toBe("digest");
    expect(js.strict).toBe(true);
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validDigest));
    const client = new DirectLLMClient(
      { ...openaiSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hello", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError on malformed response (missing choices)", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when content is not valid JSON", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ choices: [{ message: { content: "not json" } }] }),
    );
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when required fields are missing", async () => {
    const bad = { ...validDigest, summary: undefined };
    const { fetchImpl } = makeFetch(() => openaiOk(bad));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when tags count is wrong", async () => {
    const bad = { ...validDigest, tags: ["one"] };
    const { fetchImpl } = makeFetch(() => openaiOk(bad));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when a tag is not kebab-case", async () => {
    const bad = { ...validDigest, tags: ["Rust", "Memory Safety", "systems"] };
    const { fetchImpl } = makeFetch(() => openaiOk(bad));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:true on 200", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(true);
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("Unauthorized", { status: 401 }),
    );
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });

  it("ping returns ok:false when fetch throws, without throwing", async () => {
    const fetchImpl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("network down");
  });
});

describe("DirectLLMClient — Anthropic", () => {
  it("sends the correct URL, headers, and body shape", async () => {
    const { fetchImpl, captured } = makeFetch(() => anthropicOk(validDigest));
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    const digest = await client.digest("hello", {
      url: "https://example.com",
    });
    expect(digest).toEqual(validDigest);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
    );
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(body.system).toBeTypeOf("string");
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("record_digest");
    expect(tools[0]!.input_schema).toBeDefined();
    const choice = body.tool_choice as Record<string, unknown>;
    expect(choice.type).toBe("tool");
    expect(choice.name).toBe("record_digest");
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => anthropicOk(validDigest));
    const client = new DirectLLMClient(
      { ...anthropicSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hello", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError when tool_use block is missing", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ content: [{ type: "text", text: "hi" }] }),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError on HTTP error", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("bad request", { status: 400 }),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("Unauthorized", { status: 401 }),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
  });
});

describe("DirectLLMClient — Groq", () => {
  it("sends the correct URL, headers, and body shape", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validDigest));
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    const digest = await client.digest("hello", {
      url: "https://example.com",
      title: "Ex",
    });
    expect(digest).toEqual(validDigest);
    expect(captured).toHaveLength(1);
    const req = captured[0]!;
    expect(req.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/groq/chat/completions",
    );
    expect(req.headers["authorization"]).toBe("Bearer gsk-test");
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.headers["cf-aig-authorization"]).toBeUndefined();

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("llama-3.3-70b-versatile");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    // Groq json_object mode requires an explicit JSON instruction in messages;
    // verify the system prompt embeds JSON directive + a schema-shaped field.
    expect(messages[0]!.content).toContain("JSON");
    expect(messages[0]!.content).toContain("takeaway");
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("URL: https://example.com");
    expect(messages[1]!.content).toContain("<article>");
    const rf = body.response_format as Record<string, unknown>;
    expect(rf.type).toBe("json_object");
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validDigest));
    const client = new DirectLLMClient(
      { ...groqSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.digest("hello", { url: "https://example.com" });
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError on malformed response (missing choices)", async () => {
    const { fetchImpl } = makeFetch(() => jsonResponse({}));
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when content is not valid JSON", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({ choices: [{ message: { content: "not json" } }] }),
    );
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError when required fields are missing", async () => {
    const bad = { ...validDigest, summary: undefined };
    const { fetchImpl } = makeFetch(() => openaiOk(bad));
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError on HTTP error", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("bad request", { status: 400 }),
    );
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    await expect(
      client.digest("x", { url: "https://example.com" }),
    ).rejects.toThrow(DigestError);
  });

  it("ping returns ok:true on 200", async () => {
    const { fetchImpl, captured } = makeFetch(() => jsonResponse({}));
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(true);
    expect(captured[0]!.url).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct/gw/groq/chat/completions",
    );
    expect(captured[0]!.headers["authorization"]).toBe("Bearer gsk-test");
  });

  it("ping returns ok:false on 401 without throwing", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("Unauthorized", { status: 401 }),
    );
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    const result = await client.ping();
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("401");
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

function anthropicSynthesisOk(payload: unknown): Response {
  return jsonResponse({
    content: [
      { type: "tool_use", name: "record_digest_synthesis", input: payload },
    ],
  });
}

describe("DirectLLMClient — OpenAI synthesis", () => {
  it("posts to the same chat/completions URL with a json_schema response format", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validSynthesis));
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
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
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toContain("<candidates>");
    expect(messages[1]!.content).toContain("https://a.example/one");
    expect(messages[1]!.content).toContain("Maximum items to select: 2");

    const rf = body.response_format as Record<string, unknown>;
    expect(rf.type).toBe("json_schema");
    const js = rf.json_schema as Record<string, unknown>;
    expect(js.name).toBe("digest_synthesis");
    expect(js.strict).toBe(true);
    expect(js.schema).toBeDefined();
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validSynthesis));
    const client = new DirectLLMClient(
      { ...openaiSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError on HTTP error", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("bad request", { status: 400 }),
    );
    const client = new DirectLLMClient(openaiSettings, fetchImpl);
    await expect(
      client.synthesizeDigest(synthesisInputs, synthesisOpts),
    ).rejects.toThrow(DigestError);
  });
});

describe("DirectLLMClient — Anthropic synthesis", () => {
  it("posts to the same v1/messages URL with forced tool use", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicSynthesisOk(validSynthesis),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
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
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");

    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe("claude-3-5-sonnet-20241022");
    expect(body.system).toContain("UNTRUSTED DATA");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toContain("<candidates>");
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("record_digest_synthesis");
    expect(tools[0]!.input_schema).toBeDefined();
    const choice = body.tool_choice as Record<string, unknown>;
    expect(choice.type).toBe("tool");
    expect(choice.name).toBe("record_digest_synthesis");
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      anthropicSynthesisOk(validSynthesis),
    );
    const client = new DirectLLMClient(
      { ...anthropicSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError when the synthesis tool_use block is missing", async () => {
    const { fetchImpl } = makeFetch(() =>
      jsonResponse({
        content: [{ type: "tool_use", name: "record_digest", input: {} }],
      }),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    await expect(
      client.synthesizeDigest(synthesisInputs, synthesisOpts),
    ).rejects.toThrow(DigestError);
  });

  it("throws DigestError on HTTP error", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("bad request", { status: 400 }),
    );
    const client = new DirectLLMClient(anthropicSettings, fetchImpl);
    await expect(
      client.synthesizeDigest(synthesisInputs, synthesisOpts),
    ).rejects.toThrow(DigestError);
  });
});

describe("DirectLLMClient — Groq synthesis", () => {
  it("posts to the same chat/completions URL with json_object mode and the schema in the prompt", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validSynthesis));
    const client = new DirectLLMClient(groqSettings, fetchImpl);
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
    expect(body.model).toBe("llama-3.3-70b-versatile");
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toContain("UNTRUSTED DATA");
    expect(messages[0]!.content).toContain("JSON");
    expect(messages[0]!.content).toContain("canonicalUrl");
    expect(messages[1]!.content).toContain("<candidates>");
    const rf = body.response_format as Record<string, unknown>;
    expect(rf.type).toBe("json_object");
  });

  it("sends cf-aig-authorization when cfAigToken is set", async () => {
    const { fetchImpl, captured } = makeFetch(() => openaiOk(validSynthesis));
    const client = new DirectLLMClient(
      { ...groqSettings, cfAigToken: "gw-token" },
      fetchImpl,
    );
    await client.synthesizeDigest(synthesisInputs, synthesisOpts);
    expect(captured[0]!.headers["cf-aig-authorization"]).toBe("Bearer gw-token");
  });

  it("throws DigestError on HTTP error", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("bad request", { status: 400 }),
    );
    const client = new DirectLLMClient(groqSettings, fetchImpl);
    await expect(
      client.synthesizeDigest(synthesisInputs, synthesisOpts),
    ).rejects.toThrow(DigestError);
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
    ok: openaiOk,
    nonJson: () => jsonResponse({ choices: [{ message: { content: "{" } }] }),
  },
  {
    label: "Anthropic",
    settings: anthropicSettings,
    ok: anthropicSynthesisOk,
    nonJson: () => new Response("<html>gateway error</html>", { status: 200 }),
  },
  {
    label: "Groq",
    settings: groqSettings,
    ok: openaiOk,
    nonJson: () => jsonResponse({ choices: [{ message: { content: "{" } }] }),
  },
];

for (const dialect of synthesisDialects) {
  describe(`DirectLLMClient — ${dialect.label} synthesis validation`, () => {
    const run = (payload: unknown, maxItems = synthesisOpts.maxItems) => {
      const { fetchImpl } = makeFetch(() => dialect.ok(payload));
      const client = new DirectLLMClient(dialect.settings, fetchImpl);
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
      const client = new DirectLLMClient(dialect.settings, fetchImpl);
      await expect(
        client.synthesizeDigest(synthesisInputs, synthesisOpts),
      ).rejects.toThrow(DigestError);
    });
  });
}
