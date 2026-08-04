import { describe, expect, it } from "vitest";
import { EmbeddingError } from "./errors.js";
import {
  createOllamaEmbedder,
  EMBEDDING_DIMENSIONS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OllamaEmbedder,
} from "./ollama-embedder.js";

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

function embedResponse(embeddings: number[][], model = "bge-m3"): Response {
  return new Response(JSON.stringify({ model, embeddings }), {
    status: 200,
    headers: { "content-type": "application/json" },
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

describe("OllamaEmbedder", () => {
  it("exposes the default model and dimensions", () => {
    const embedder = createOllamaEmbedder();
    expect(embedder.model).toBe("bge-m3");
    expect(embedder.model).toBe(OLLAMA_DEFAULT_MODEL);
    expect(embedder.dimensions).toBe(1024);
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
    expect(OLLAMA_DEFAULT_BASE_URL).toBe("http://localhost:11434");
  });

  it("posts to {baseUrl}/api/embed with model and input", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      embedResponse([vector(EMBEDDING_DIMENSIONS)]),
    );
    await createOllamaEmbedder({ fetchImpl }).embed(["hello"]);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe("http://localhost:11434/api/embed");
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.headers["content-type"]).toBe("application/json");
    expect(body(captured[0])).toEqual({ model: "bge-m3", input: ["hello"] });
  });

  it("does not use the legacy /api/embeddings endpoint or a prompt field", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      embedResponse([vector(EMBEDDING_DIMENSIONS)]),
    );
    await createOllamaEmbedder({ fetchImpl }).embed(["hello"]);
    expect(captured[0]?.url.endsWith("/api/embed")).toBe(true);
    expect(body(captured[0])).not.toHaveProperty("prompt");
  });

  it("batches every text into a single request", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      embedResponse([vector(4, 1), vector(4, 2), vector(4, 3)]),
    );
    const vectors = await createOllamaEmbedder({
      fetchImpl,
      dimensions: 4,
    }).embed(["one", "two", "three"]);

    expect(captured).toHaveLength(1);
    expect(body(captured[0]).input).toEqual(["one", "two", "three"]);
    expect(vectors).toHaveLength(3);
    for (const v of vectors) expect(v).toHaveLength(4);
  });

  it("makes no request for an empty batch", async () => {
    const { fetchImpl, captured } = makeFetch(() => embedResponse([]));
    const vectors = await createOllamaEmbedder({ fetchImpl }).embed([]);
    expect(vectors).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  it("returns unit-length vectors even when the server does not", async () => {
    const { fetchImpl } = makeFetch(() => embedResponse([[3, 4]]));
    const vectors = await createOllamaEmbedder({
      fetchImpl,
      dimensions: 2,
    }).embed(["unnormalized"]);

    expect(vectors[0]).toEqual([0.6, 0.8]);
    expect(magnitude(vectors[0] ?? [])).toBeCloseTo(1, 12);
  });

  it("normalizes every vector in a batch", async () => {
    const { fetchImpl } = makeFetch(() =>
      embedResponse([
        [0, 5],
        [-2, 0],
        [1, 1],
      ]),
    );
    const vectors = await createOllamaEmbedder({
      fetchImpl,
      dimensions: 2,
    }).embed(["a", "b", "c"]);

    expect(vectors).toHaveLength(3);
    for (const v of vectors) expect(magnitude(v)).toBeCloseTo(1, 12);
    expect(vectors[1]).toEqual([-1, 0]);
  });

  it("honours a custom baseUrl and model", async () => {
    const { fetchImpl, captured } = makeFetch(() =>
      embedResponse([vector(4)], "mxbai-embed-large"),
    );
    await createOllamaEmbedder({
      fetchImpl,
      baseUrl: "http://ollama.internal:9999",
      model: "mxbai-embed-large",
      dimensions: 4,
    }).embed(["hi"]);

    expect(captured[0]?.url).toBe("http://ollama.internal:9999/api/embed");
    expect(body(captured[0]).model).toBe("mxbai-embed-large");
  });

  it("tolerates a trailing slash on baseUrl", async () => {
    const { fetchImpl, captured } = makeFetch(() => embedResponse([vector(4)]));
    await createOllamaEmbedder({
      fetchImpl,
      baseUrl: "http://localhost:11434/",
      dimensions: 4,
    }).embed(["hi"]);
    expect(captured[0]?.url).toBe("http://localhost:11434/api/embed");
  });

  it("throws EmbeddingError on HTTP 500", async () => {
    const { fetchImpl } = makeFetch(
      () => new Response("boom", { status: 500 }),
    );
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).toContain("boom");
  });

  it("throws EmbeddingError when the model is missing (HTTP 404)", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify({ error: 'model "bge-m3" not found' }), {
          status: 404,
        }),
    );
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("not found");
  });

  it("throws EmbeddingError when the transport fails", async () => {
    const { fetchImpl } = makeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
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
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("JSON");
  });

  it("throws EmbeddingError when 'embeddings' is missing", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(JSON.stringify({ model: "bge-m3", embedding: [1, 2] }), {
          status: 200,
        }),
    );
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("embeddings");
  });

  it("throws EmbeddingError when the count does not match the batch", async () => {
    const { fetchImpl } = makeFetch(() =>
      embedResponse([vector(4, 1), vector(4, 2)]),
    );
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl, dimensions: 4 }).embed([
        "one",
        "two",
        "three",
      ]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("3");
    expect((err as Error).message).toContain("2");
  });

  it("throws EmbeddingError naming both dimensions on a mismatch", async () => {
    const { fetchImpl } = makeFetch(() => embedResponse([vector(768)]));
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("1024");
    expect((err as Error).message).toContain("768");
  });

  it("throws EmbeddingError on a non-numeric embedding", async () => {
    const { fetchImpl } = makeFetch(
      () =>
        new Response(
          JSON.stringify({ model: "bge-m3", embeddings: [["a", "b"]] }),
          { status: 200 },
        ),
    );
    const err = await rejection(() =>
      createOllamaEmbedder({ fetchImpl, dimensions: 2 }).embed(["hi"]),
    );
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toContain("non-numeric");
  });

  it("is constructible directly and reports its endpoint", () => {
    const embedder = new OllamaEmbedder({ baseUrl: "http://host:1/" });
    expect(embedder.endpoint).toBe("http://host:1/api/embed");
  });
});
