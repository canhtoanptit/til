import { beforeEach, describe, expect, it, vi } from "vitest";
import { entries, entryVectors } from "@til/db";
import type { VectorRecord } from "@til/core";
import type { Deps } from "./deps.js";
import { createTestDb, insertEntry } from "./test-harness.js";
import {
  D1VectorStore,
  isVectorizeIndexLike,
  VectorizeStore,
} from "./vector-store.js";

const DIMS = 4;

function unit(values: number[]): number[] {
  const magnitude = Math.sqrt(values.reduce((sum, v) => sum + v * v, 0));
  return values.map((v) => v / magnitude);
}

function record(id: string, values: number[]): VectorRecord {
  return {
    id,
    userId: "owner",
    values: unit(values),
    metadata: { domain: "example.com", createdAt: 1, embedModel: "stub-embed" },
  };
}

describe("D1VectorStore", () => {
  let db: Deps["db"];
  let store: D1VectorStore;

  beforeEach(async () => {
    ({ db } = createTestDb());
    store = new D1VectorStore(db, DIMS, () => 1_700_000_000_000);
    await insertEntry(db, { id: "a", canonicalUrl: "https://example.com/a" });
    await insertEntry(db, { id: "b", canonicalUrl: "https://example.com/b" });
    await insertEntry(db, { id: "c", canonicalUrl: "https://example.com/c" });
  });

  it("round-trips upsert → query, ranked by cosine similarity", async () => {
    await store.upsert([
      record("a", [1, 0, 0, 0]),
      record("b", [0.9, 0.1, 0, 0]),
      record("c", [0, 0, 0, 1]),
    ]);

    const matches = await store.query(unit([1, 0, 0, 0]), {
      topK: 3,
      userId: "owner",
    });
    expect(matches.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(matches[0]?.score).toBeCloseTo(1, 5);
    expect(matches[2]?.score).toBeCloseTo(0, 5);
  });

  it("respects topK", async () => {
    await store.upsert([
      record("a", [1, 0, 0, 0]),
      record("b", [0.9, 0.1, 0, 0]),
      record("c", [0, 0, 0, 1]),
    ]);
    const matches = await store.query(unit([1, 0, 0, 0]), {
      topK: 2,
      userId: "owner",
    });
    expect(matches.map((m) => m.id)).toEqual(["a", "b"]);
  });

  it("upsert replaces an existing vector rather than duplicating it", async () => {
    await store.upsert([record("a", [1, 0, 0, 0])]);
    await store.upsert([record("a", [0, 0, 0, 1])]);

    const rows = await db.select().from(entryVectors);
    expect(rows).toHaveLength(1);
    const matches = await store.query(unit([0, 0, 0, 1]), {
      topK: 3,
      userId: "owner",
    });
    expect(matches[0]?.score).toBeCloseTo(1, 5);
  });

  it("deleteByIds removes only the named vectors", async () => {
    await store.upsert([record("a", [1, 0, 0, 0]), record("b", [0, 1, 0, 0])]);
    await store.deleteByIds(["a"]);
    const rows = await db.select().from(entryVectors);
    expect(rows.map((r) => r.entryId)).toEqual(["b"]);
  });

  it("skips and logs rows whose dims differ from the query vector", async () => {
    await store.upsert([record("a", [1, 0, 0, 0])]);
    await db.insert(entryVectors).values({
      entryId: "b",
      embedModel: "nomic-embed-text",
      dims: 3,
      values: JSON.stringify([1, 0, 0]),
      createdAt: 1,
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matches = await store.query(unit([1, 0, 0, 0]), {
      topK: 5,
      userId: "owner",
    });
    expect(matches.map((m) => m.id)).toEqual(["a"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("skipped 1 vector"),
    );
    warn.mockRestore();
  });

  it("skips rows whose stored JSON is not a numeric vector", async () => {
    await db.insert(entryVectors).values({
      entryId: "a",
      embedModel: "stub-embed",
      dims: DIMS,
      values: "not json",
      createdAt: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      store.query(unit([1, 0, 0, 0]), { topK: 5, userId: "owner" }),
    ).resolves.toEqual([]);
    warn.mockRestore();
  });

  it("rejects a vector whose length does not match the index", async () => {
    await expect(
      store.upsert([
        {
          id: "a",
          userId: "owner",
          values: [1, 0, 0],
          metadata: { domain: "", createdAt: 1, embedModel: "x" },
        },
      ]),
    ).rejects.toThrow(/3 dimensions, index expects 4/);
    await expect(
      store.query([1, 0, 0], { topK: 1, userId: "owner" }),
    ).rejects.toThrow(/3 dimensions, index expects 4/);
  });

  it("cascades when the owning entry is deleted", async () => {
    await store.upsert([record("a", [1, 0, 0, 0]), record("b", [0, 1, 0, 0])]);
    const { eq } = await import("drizzle-orm");
    await db.delete(entries).where(eq(entries.id, "a"));

    const rows = await db.select().from(entryVectors);
    expect(rows.map((r) => r.entryId)).toEqual(["b"]);
  });

  it("getVector round-trips the stored vector for one id", async () => {
    const stored = unit([1, 2, 3, 4]);
    await store.upsert([record("a", [1, 2, 3, 4]), record("b", [0, 1, 0, 0])]);
    const values = await store.getVector("a");
    expect(values).toHaveLength(DIMS);
    values?.forEach((value, i) =>
      expect(value).toBeCloseTo(stored[i] ?? 0, 10),
    );
  });

  it("getVector returns null for an id with no vector, and for the empty id", async () => {
    await store.upsert([record("a", [1, 0, 0, 0])]);
    await expect(store.getVector("b")).resolves.toBeNull();
    await expect(store.getVector("nope")).resolves.toBeNull();
    await expect(store.getVector("")).resolves.toBeNull();
  });

  it("getVector refuses an off-dimension row rather than returning it", async () => {
    // WHY it must be null: the only use for the result is VectorStore.query,
    // which throws on a vector of the wrong width.
    await db.insert(entryVectors).values({
      entryId: "a",
      embedModel: "nomic-embed-text",
      dims: 3,
      values: JSON.stringify([1, 0, 0]),
      createdAt: 1,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.getVector("a")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("3 dimensions, index expects 4"),
    );
    warn.mockRestore();
  });

  it("getVector returns null when the stored JSON is not a numeric vector", async () => {
    await db.insert(entryVectors).values({
      entryId: "a",
      embedModel: "stub-embed",
      dims: DIMS,
      values: "not json",
      createdAt: 1,
    });
    await expect(store.getVector("a")).resolves.toBeNull();
  });

  it("returns nothing for an empty index or a non-positive topK", async () => {
    await expect(
      store.query(unit([1, 0, 0, 0]), { topK: 3, userId: "owner" }),
    ).resolves.toEqual([]);
    await store.upsert([record("a", [1, 0, 0, 0])]);
    await expect(
      store.query(unit([1, 0, 0, 0]), { topK: 0, userId: "owner" }),
    ).resolves.toEqual([]);
  });
});

describe("VectorizeStore", () => {
  // Shaped after @cloudflare/workers-types 5.20260801.1: getByIds resolves to
  // VectorizeVector[] holding only the ids that exist, and `values` is typed
  // `VectorFloatArray | number[]` — so the store must accept a typed array.
  function stubIndex(
    stored: { id: string; values: number[] | Float32Array }[] = [],
  ) {
    const upserts: {
      id: string;
      values: number[];
      namespace?: string;
      metadata?: unknown;
    }[] = [];
    const queries: { values: number[]; opts?: unknown }[] = [];
    const deletes: string[][] = [];
    const gets: string[][] = [];
    return {
      upserts,
      queries,
      deletes,
      gets,
      index: {
        upsert: async (vectors: typeof upserts) => {
          upserts.push(...vectors);
          return { mutationId: "1" };
        },
        query: async (values: number[], opts?: unknown) => {
          queries.push({ values, opts });
          return {
            matches: [
              { id: "a", score: 0.91 },
              { id: "b", score: 0.42 },
            ],
          };
        },
        getByIds: async (ids: string[]) => {
          gets.push(ids);
          return stored.filter((vector) => ids.includes(vector.id));
        },
        deleteByIds: async (ids: string[]) => {
          deletes.push(ids);
          return { mutationId: "2" };
        },
      },
    };
  }

  it("forwards upserts with flattened metadata", async () => {
    const stub = stubIndex();
    const store = new VectorizeStore(stub.index, DIMS);
    await store.upsert([record("a", [1, 0, 0, 0])]);
    expect(stub.upserts).toHaveLength(1);
    expect(stub.upserts[0]?.id).toBe("a");
    // The tenant rides as a Vectorize namespace, never as filterable metadata.
    expect(stub.upserts[0]?.namespace).toBe("owner");
    expect(stub.upserts[0]?.metadata).toEqual({
      domain: "example.com",
      createdAt: 1,
      embedModel: "stub-embed",
    });
  });

  it("maps matches to VectorMatch and passes topK through", async () => {
    const stub = stubIndex();
    const store = new VectorizeStore(stub.index, DIMS);
    const matches = await store.query(unit([1, 0, 0, 0]), {
      topK: 7,
      userId: "owner",
    });
    expect(matches).toEqual([
      { id: "a", score: 0.91 },
      { id: "b", score: 0.42 },
    ]);
    expect(stub.queries[0]?.opts).toEqual({ topK: 7, namespace: "owner" });
  });

  it("forwards deleteByIds and skips empty calls", async () => {
    const stub = stubIndex();
    const store = new VectorizeStore(stub.index, DIMS);
    await store.deleteByIds(["a", "b"]);
    await store.deleteByIds([]);
    expect(stub.deletes).toEqual([["a", "b"]]);
  });

  it("rejects a vector whose length does not match the index", async () => {
    const stub = stubIndex();
    const store = new VectorizeStore(stub.index, DIMS);
    await expect(
      store.upsert([
        {
          id: "a",
          userId: "owner",
          values: [1, 2],
          metadata: { domain: "", createdAt: 1, embedModel: "x" },
        },
      ]),
    ).rejects.toThrow(/2 dimensions, index expects 4/);
    expect(stub.upserts).toHaveLength(0);
  });

  it("tolerates a binding that returns no matches array", async () => {
    const store = new VectorizeStore(
      {
        upsert: async () => ({}),
        query: async () => ({}),
        getByIds: async () => [],
        deleteByIds: async () => ({}),
      },
      DIMS,
    );
    await expect(
      store.query(unit([1, 0, 0, 0]), { topK: 3, userId: "owner" }),
    ).resolves.toEqual([]);
  });

  it("getVector fetches one id through getByIds", async () => {
    const stub = stubIndex([{ id: "a", values: [1, 0, 0, 0] }]);
    const store = new VectorizeStore(stub.index, DIMS);
    await expect(store.getVector("a")).resolves.toEqual([1, 0, 0, 0]);
    expect(stub.gets).toEqual([["a"]]);
  });

  it("getVector converts the typed array the runtime may return", async () => {
    const stub = stubIndex([
      { id: "a", values: new Float32Array([0, 1, 0, 0]) },
    ]);
    const store = new VectorizeStore(stub.index, DIMS);
    const values = await store.getVector("a");
    expect(Array.isArray(values)).toBe(true);
    expect(values).toEqual([0, 1, 0, 0]);
  });

  it("getVector matches on id rather than position", async () => {
    // A miss is an omitted element, not a null hole, so `stored[0]` would be the
    // wrong vector whenever the index returns anything at all.
    const stub = stubIndex([
      { id: "a", values: [1, 0, 0, 0] },
      { id: "b", values: [0, 0, 1, 0] },
    ]);
    const store = new VectorizeStore(stub.index, DIMS);
    await expect(store.getVector("b")).resolves.toEqual([0, 0, 1, 0]);
  });

  it("getVector returns null for a missing id, an empty id and absent values", async () => {
    const stub = stubIndex([{ id: "a", values: [1, 0, 0, 0] }]);
    const store = new VectorizeStore(stub.index, DIMS);
    await expect(store.getVector("zz")).resolves.toBeNull();
    await expect(store.getVector("")).resolves.toBeNull();
    expect(stub.gets).toEqual([["zz"]]);

    const valueless = new VectorizeStore(
      {
        upsert: async () => ({}),
        query: async () => ({ matches: [] }),
        getByIds: async () => [{ id: "a" }],
        deleteByIds: async () => ({}),
      },
      DIMS,
    );
    await expect(valueless.getVector("a")).resolves.toBeNull();
  });

  it("getVector refuses an off-dimension vector", async () => {
    const stub = stubIndex([{ id: "a", values: [1, 0, 0] }]);
    const store = new VectorizeStore(stub.index, DIMS);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(store.getVector("a")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("3 dimensions, index expects 4"),
    );
    warn.mockRestore();
  });
});

describe("isVectorizeIndexLike", () => {
  it("rejects absent or partial bindings", () => {
    expect(isVectorizeIndexLike(null)).toBe(false);
    expect(isVectorizeIndexLike(undefined)).toBe(false);
    expect(isVectorizeIndexLike({ upsert: () => {} })).toBe(false);
  });

  it("rejects a binding without getByIds — getVector needs it", () => {
    expect(
      isVectorizeIndexLike({
        upsert: () => {},
        query: () => {},
        deleteByIds: () => {},
      }),
    ).toBe(false);
  });

  it("accepts a full binding", () => {
    expect(
      isVectorizeIndexLike({
        upsert: () => {},
        query: () => {},
        getByIds: () => {},
        deleteByIds: () => {},
      }),
    ).toBe(true);
  });
});
