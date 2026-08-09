import { describe, expect, it } from "vitest";
import { EmbeddingError } from "./errors.js";
import { EMBEDDING_DIMENSIONS } from "./ollama-embedder.js";
import {
  createWorkersAIRestEmbedder,
  WORKERS_AI_DEFAULT_MODEL,
  WORKERS_AI_REST_BASE_URL,
  WorkersAIRestEmbedder,
} from "./workers-ai-rest-embedder.js";

const ACCOUNT = "acct-123";
const TOKEN = "cf-secret-token";

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(
  respond: (req: CapturedRequest) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; captured: CapturedRequest[] } {
  const captured: CapturedRequest[] = [];
  const fetchImpl = (async (
    input: Request | string | URL,
    init?: RequestInit,
  ) => {
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) {
      headers[k.toLowerCase()] = v;
    }
    const req: CapturedRequest = {
      url: typeof input === "string" ? input : input.toString(),
      method: init?.method ?? "GET",
      headers,
      body:
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : undefined,
    };
    captured.push(req);
    return respond(req);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

function runResponse(data: number[][]): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result: { shape: [data.length, data[0]?.length ?? 0], data },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function embedder(
  fetchImpl: typeof fetch,
  overrides: { model?: string; dimensions?: number } = {},
) {
  return createWorkersAIRestEmbedder({
    accountId: ACCOUNT,
    apiToken: TOKEN,
    fetchImpl,
    ...overrides,
  });
}

function vector(dims: number, seed = 1): number[] {
  return Array.from({ length: dims }, (_, i) => seed + i);
}

function magnitude(v: readonly number[]): number {
  let sum = 0;
  for (const value of v) sum += value * value;
  return Math.sqrt(sum);
}

function body(req: CapturedRequest | undefined): Record<string, unknown> {
  if (req === undefined || typeof req.body !== "object" || req.body === null) {
    throw new Error("no JSON request body captured");
  }
  return req.body as Record<string, unknown>;
}

async function rejection(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("WorkersAIRestEmbedder", () => {
  it("exposes the default model and dimensions", () => {
    const { fetchImpl } = makeFetch(() => runResponse([]));
    const instance = embedder(fetchImpl);
    expect(instance.model).toBe("bge-m3");
    expect(instance.model).toBe(WORKERS_AI_DEFAULT_MODEL);
    expect(instance.dimensions).toBe(1024);
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(WORKERS_AI_REST_BASE_URL).toBe(
      "https://api.cloudflare.com/client/v4",
    );
  });

  it("posts to the account's ai/run path for @cf/baai/bge-m3", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      runResponse([vector(EMBEDDING_DIMENSIONS)]),
    );
    await embedder(fetchImpl).embed(["hello"]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-m3",
    );
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers["content-type"]).toBe("application/json");
  });

  it("sends the api token as a bearer header", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      runResponse([vector(EMBEDDING_DIMENSIONS)]),
    );
    await embedder(fetchImpl).embed(["hello"]);
    expect(captured[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
  });

  it("sends the batch under the 'text' key, not 'input'", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      runResponse([vector(EMBEDDING_DIMENSIONS)]),
    );
    await embedder(fetchImpl).embed(["hello"]);
    expect(body(captured[0])).toEqual({ text: ["hello"] });
    expect(body(captured[0])).not.toHaveProperty("input");
  });

  it("batches every text into a single request", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      runResponse([vector(4, 1), vector(4, 2), vector(4, 3)]),
    );
    const vectors = await embedder(fetchImpl, { dimensions: 4 }).embed([
      "one",
      "two",
      "three",
    ]);

    expect(captured).toHaveLength(1);
    expect(body(captured[0]).text).toEqual(["one", "two", "three"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) expect(v).toHaveLength(4);
  });

  it("makes no request for an empty batch", async () => {
    const { fetchImpl, captured } = makeFetch(() => runResponse([]));
    const vectors = await embedder(fetchImpl).embed([]);
    expect(vectors).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("returns unit-length vectors even when the API does not", async () => {
    const { fetchImpl } = makeFetch(() => runResponse([[3, 4]]));
    const vectors = await embedder(fetchImpl, { dimensions: 2 }).embed(["x"]);
    expect(vectors[0]).toEqual([0.6, 0.8]);
    expect(magnitude(vectors[0] ?? [])).toBeCloseTo(1, 12);
  });

  it("normalizes every vector in a batch", async () => {
    const { fetchImpl } = makeFetch(() =>
      runResponse([
        [0, 5],
        [-2, 0],
        [1, 1],
      ]),
    );
    const vectors = await embedder(fetchImpl, { dimensions: 2 }).embed([
      "a",
      "b",
      "c",
    ]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) expect(magnitude(v)).toBeCloseTo(1, 12);
    expect(vectors[1]).toEqual([-1, 0]);
  });

  it("accepts a fully qualified model id verbatim", async () => {
    const { fetchImpl, captured } = makeFetch(() => runResponse([vector(4)]));
    await embedder(fetchImpl, {
      model: "@cf/qwen/qwen3-embedding-0.6b",
      dimensions: 4,
    }).embed(["hi"]);
    expect(captured[0]?.url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/qwen/qwen3-embedding-0.6b",
    );
  });

  it("rejects an empty accountId or apiToken up front", () => {
    expect(() =>
      createWorkersAIRestEmbedder({ accountId: " ", apiToken: TOKEN }),
    ).toThrow(EmbeddingError);
    expect(() =>
      createWorkersAIRestEmbedder({ accountId: ACCOUNT, apiToken: "" }),
    ).toThrow(EmbeddingError);
  });

  it("throws EmbeddingError on HTTP 500", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).toContain("boom");
  });

  it("names the token permission on HTTP 401/403", async () => {
    for (const status of [401, 403]) {
      const { fetchImpl } = makeFetch(
        () =>
          new Response(
            JSON.stringify({
              success: false,
              errors: [{ code: 10000, message: "Authentication error" }],
            }),
            { status },
          ),
      );
      const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
      expect(err).toBeInstanceOf(EmbeddingError);
      expect((err as Error).message).toContain("WORKERS_AI_API_TOKEN");
    }
  });

  it("throws EmbeddingError on a 200 with success:false, quoting the API error", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 3006, message: "Model not found" }],
            result: null,
          }),
          { status: 200 },
        ),
    );
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("success:false");
    expect((err as Error).message).toContain("Model not found");
  });

  it("throws EmbeddingError when the transport fails", async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("fetch failed");
  });

  it("throws EmbeddingError on an unparseable body", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("JSON");
  });

  it("throws EmbeddingError when 'result.data' is missing", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify({ success: true, result: { shape: [] } }), {
          status: 200,
        }),
    );
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("result.data");
  });

  it("throws EmbeddingError when the count does not match the batch", async () => {
    const { fetchImpl } = makeFetch(() =>
      runResponse([vector(4, 1), vector(4, 2)]),
    );
    const err = await rejection(() =>
      embedder(fetchImpl, { dimensions: 4 }).embed(["one", "two", "three"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("3");
    expect((err as Error).message).toContain("2");
  });

  it("throws EmbeddingError naming both dimensions on a mismatch", async () => {
    const { fetchImpl } = makeFetch(() => runResponse([vector(768)]));
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("1024");
    expect((err as Error).message).toContain("768");
  });

  it("throws EmbeddingError on a non-numeric embedding", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({ success: true, result: { data: [["a", "b"]] } }),
          { status: 200 },
        ),
    );
    const err = await rejection(() =>
      embedder(fetchImpl, { dimensions: 2 }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("non-numeric");
  });

  it("never leaks the api token into an error message", async () => {
    const cases: (() => Response)[] = [
      () => new Response(`bad token: ${TOKEN}`, { status: 403 }),
      () =>
        new Response(
          JSON.stringify({
            success: false,
            errors: [{ code: 10000, message: `token ${TOKEN} is invalid` }],
          }),
          { status: 200 },
        ),
    ];
    for (const respond of cases) {
      const { fetchImpl } = makeFetch(respond);
      const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
      expect((err as Error).message).not.toContain(TOKEN);
      expect((err as Error).message).toContain("[redacted]");
    }

    const { fetchImpl } = makeFetch(() => {
      throw new Error(`connect failed with Bearer ${TOKEN}`);
    });
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it("keeps the account id out of error prose", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("nope", { status: 500 }),
    );
    const err = await rejection(() => embedder(fetchImpl).embed(["hi"]));
    expect((err as Error).message).not.toContain(ACCOUNT);
    expect((err as Error).message).toContain("{account_id}");
  });

  it("is constructible directly and reports its endpoint", () => {
    const instance = new WorkersAIRestEmbedder({
      accountId: ACCOUNT,
      apiToken: TOKEN,
    });
    expect(instance.restModel).toBe("@cf/baai/bge-m3");
    expect(instance.endpoint).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acct-123/ai/run/@cf/baai/bge-m3",
    );
  });
});
