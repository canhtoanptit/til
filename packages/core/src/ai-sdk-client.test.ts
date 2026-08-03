import { describe, expect, it } from "vitest";
import { AISDKClient } from "./ai-sdk-client.js";
import { DigestError } from "./errors.js";
import type { LLMSettings } from "./types.js";

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
