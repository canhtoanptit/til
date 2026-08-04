import { describe, expect, it, vi } from "vitest";
import { OllamaEmbedder } from "@til/core";
import { WorkersAIEmbedder } from "./embedders.js";
import { ReadabilityExtractor, WorkersAIExtractor } from "./extractors.js";
import { resolveStack, resolveStackMode } from "./stack.js";
import { createTestDb } from "./test-harness.js";
import { D1VectorStore, VectorizeStore } from "./vector-store.js";

function ctx() {
  const { db } = createTestDb();
  return { db, fetchImpl: (async () => new Response("{}")) as typeof fetch };
}

const CLOUD_BINDINGS = {
  AI: { run: async () => ({ data: [[]] }), toMarkdown: async () => ({}) },
  VECTORIZE: {
    upsert: async () => {},
    query: async () => ({ matches: [] }),
    deleteByIds: async () => {},
  },
};

describe("resolveStackMode", () => {
  it("defaults to local when unset", () => {
    expect(resolveStackMode(undefined)).toBe("local");
    expect(resolveStackMode(null)).toBe("local");
    expect(resolveStackMode("")).toBe("local");
    expect(resolveStackMode("   ")).toBe("local");
  });

  it("accepts cloud, case- and whitespace-insensitively", () => {
    expect(resolveStackMode("cloud")).toBe("cloud");
    expect(resolveStackMode(" CLOUD ")).toBe("cloud");
  });

  it("accepts local explicitly", () => {
    expect(resolveStackMode("local")).toBe("local");
    expect(resolveStackMode("Local")).toBe("local");
  });

  it("falls back to local on garbage and says so", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveStackMode("quantum")).toBe("local");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("resolveStack", () => {
  it("unset TIL_STACK selects the local adapter set", () => {
    const stack = resolveStack({}, ctx());
    expect(stack.mode).toBe("local");
    expect(stack.extractor).toBeInstanceOf(ReadabilityExtractor);
    expect(stack.embedder).toBeInstanceOf(OllamaEmbedder);
    expect(stack.vectorStore).toBeInstanceOf(D1VectorStore);
  });

  it("garbage TIL_STACK still selects the local adapter set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stack = resolveStack({ TIL_STACK: "nonsense" }, ctx());
    warn.mockRestore();
    expect(stack.mode).toBe("local");
    expect(stack.embedder).toBeInstanceOf(OllamaEmbedder);
    expect(stack.vectorStore).toBeInstanceOf(D1VectorStore);
  });

  it("cloud selects the Workers AI + Vectorize adapters", () => {
    const stack = resolveStack(
      { TIL_STACK: "cloud", ...CLOUD_BINDINGS },
      ctx(),
    );
    expect(stack.mode).toBe("cloud");
    expect(stack.extractor).toBeInstanceOf(WorkersAIExtractor);
    expect(stack.embedder).toBeInstanceOf(WorkersAIEmbedder);
    expect(stack.vectorStore).toBeInstanceOf(VectorizeStore);
  });

  it("cloud without the AI/Vectorize bindings leaves both adapters null", async () => {
    const stack = resolveStack({ TIL_STACK: "cloud" }, ctx());
    expect(stack.mode).toBe("cloud");
    // Extraction still has to work, so it falls back into the isolate.
    expect(stack.extractor).toBeInstanceOf(ReadabilityExtractor);
    expect(stack.embedder).toBeNull();
    expect(stack.vectorStore).toBeNull();
    await expect(stack.probeEmbedder()).resolves.toBe("unavailable");
  });

  it("local honours OLLAMA_BASE_URL", () => {
    const stack = resolveStack(
      { TIL_STACK: "local", OLLAMA_BASE_URL: "http://127.0.0.1:9999/" },
      ctx(),
    );
    expect((stack.embedder as OllamaEmbedder).endpoint).toBe(
      "http://127.0.0.1:9999/api/embed",
    );
  });
});

// The probe result is cached per base url, so each case needs its own port —
// that cache is the reason a health poll does not hammer ollama.
describe("probeEmbedder", () => {
  it("reports ok when ollama lists the embedding model", async () => {
    const { db } = createTestDb();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: "bge-m3:latest" }] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const stack = resolveStack(
      { OLLAMA_BASE_URL: "http://localhost:20001" },
      { db, fetchImpl, now: () => 1 },
    );
    await expect(stack.probeEmbedder()).resolves.toBe("ok");
  });

  it("reports unavailable when ollama is not listening, without throwing", async () => {
    const { db } = createTestDb();
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const stack = resolveStack(
      { OLLAMA_BASE_URL: "http://localhost:20002" },
      { db, fetchImpl, now: () => 1 },
    );
    await expect(stack.probeEmbedder()).resolves.toBe("unavailable");
  });

  it("reports unavailable when ollama is up but the model is not pulled", async () => {
    const { db } = createTestDb();
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ models: [{ name: "llama3:8b" }] }), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    const stack = resolveStack(
      { OLLAMA_BASE_URL: "http://localhost:20003" },
      { db, fetchImpl, now: () => 1 },
    );
    await expect(stack.probeEmbedder()).resolves.toBe("unavailable");
  });

  it("reports unavailable on a non-200 response", async () => {
    const { db } = createTestDb();
    const fetchImpl = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    const stack = resolveStack(
      { OLLAMA_BASE_URL: "http://localhost:20004" },
      { db, fetchImpl, now: () => 1 },
    );
    await expect(stack.probeEmbedder()).resolves.toBe("unavailable");
  });

  it("does not call the endpoint on every hit", async () => {
    const { db } = createTestDb();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ models: [{ name: "bge-m3" }] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const stack = resolveStack(
      { OLLAMA_BASE_URL: "http://localhost:20005" },
      { db, fetchImpl, now: () => 1 },
    );
    await stack.probeEmbedder();
    await stack.probeEmbedder();
    expect(calls).toBe(1);
  });
});
