import { describe, expect, it } from "vitest";
import { EmbeddingError } from "@til/core";
import { isAiRunLike, WorkersAIEmbedder } from "./embedders.js";

function vector(seed: number, dims = 1024): number[] {
  return Array.from({ length: dims }, (_, i) => (i === seed ? 3 : 0));
}

describe("WorkersAIEmbedder", () => {
  it("declares the shared bge-m3 model and dimensions", () => {
    const e = new WorkersAIEmbedder({ run: async () => ({ data: [] }) });
    expect(e.model).toBe("bge-m3");
    expect(e.dimensions).toBe(1024);
  });

  it("batches the whole array into one run() call", async () => {
    const calls: { model: string; text: string | string[] }[] = [];
    const e = new WorkersAIEmbedder({
      run: async (model, input) => {
        calls.push({ model, text: input.text });
        return { data: [vector(0), vector(1)] };
      },
    });
    const out = await e.embed(["a", "b"]);
    expect(calls).toEqual([{ model: "@cf/baai/bge-m3", text: ["a", "b"] }]);
    expect(out).toHaveLength(2);
  });

  it("normalizes the returned vectors", async () => {
    const e = new WorkersAIEmbedder({
      run: async () => ({ data: [vector(0)] }),
    });
    const [values] = await e.embed(["a"]);
    expect(values?.[0]).toBeCloseTo(1, 6);
    const magnitude = Math.sqrt(
      (values ?? []).reduce((sum, v) => sum + v * v, 0),
    );
    expect(magnitude).toBeCloseTo(1, 6);
  });

  it("short-circuits an empty input without calling the binding", async () => {
    let called = false;
    const e = new WorkersAIEmbedder({
      run: async () => {
        called = true;
        return { data: [] };
      },
    });
    await expect(e.embed([])).resolves.toEqual([]);
    expect(called).toBe(false);
  });

  it("wraps a binding failure in EmbeddingError", async () => {
    const e = new WorkersAIEmbedder({
      run: async () => {
        throw new Error("no neurons left");
      },
    });
    await expect(e.embed(["a"])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it("rejects a response with no data array", async () => {
    const e = new WorkersAIEmbedder({ run: async () => ({}) });
    await expect(e.embed(["a"])).rejects.toThrow(/no 'data' array/);
  });

  it("rejects a count mismatch", async () => {
    const e = new WorkersAIEmbedder({
      run: async () => ({ data: [vector(0)] }),
    });
    await expect(e.embed(["a", "b"])).rejects.toThrow(/expected 2 embeddings/);
  });

  it("rejects a wrong-width vector", async () => {
    const e = new WorkersAIEmbedder({
      run: async () => ({ data: [vector(0, 768)] }),
    });
    await expect(e.embed(["a"])).rejects.toThrow(
      /expected 1024-dimensional embeddings, got 768/,
    );
  });

  it("rejects a non-numeric vector", async () => {
    const e = new WorkersAIEmbedder({
      run: async () => ({ data: [["nope"]] }),
    });
    await expect(e.embed(["a"])).rejects.toThrow(/non-numeric embedding/);
  });
});

describe("isAiRunLike", () => {
  it("rejects absent bindings", () => {
    expect(isAiRunLike(null)).toBe(false);
    expect(isAiRunLike(undefined)).toBe(false);
    expect(isAiRunLike({ toMarkdown: () => {} })).toBe(false);
  });

  it("accepts a binding with run()", () => {
    expect(isAiRunLike({ run: () => {} })).toBe(true);
  });
});
