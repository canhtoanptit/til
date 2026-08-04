import { describe, expect, it } from "vitest";
import {
  buildTestApp,
  insertEntry,
  makeStubEmbedder,
} from "./test-harness.js";
import { indexEntry } from "./indexing.js";
import { sanitizeFtsQuery } from "./search.js";

describe("sanitizeFtsQuery", () => {
  it("returns null for empty/whitespace", () => {
    expect(sanitizeFtsQuery("")).toBeNull();
    expect(sanitizeFtsQuery("   ")).toBeNull();
  });

  it("strips FTS operators and quotes each term", () => {
    const q = sanitizeFtsQuery('foo AND "bar*" OR (baz):');
    expect(q).toBe('"foo" OR "bar" OR "baz"');
  });

  it("returns null when only operators are provided", () => {
    expect(sanitizeFtsQuery("AND OR NOT")).toBeNull();
  });
});

describe("GET /api/search", () => {
  it("returns empty items for empty q", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/search?q=");
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([]);
  });

  it("finds by summary/tags via FTS join", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "s-1",
      canonicalUrl: "https://example.com/rust",
      url: "https://example.com/rust",
      title: "Learning Rust",
      summary: "Rust ownership semantics deep dive",
      takeaway: "Ownership is a memory-safety mechanism",
      tags: ["rust", "systems"],
    });
    await insertEntry(t.deps.db, {
      id: "s-2",
      canonicalUrl: "https://example.com/python",
      url: "https://example.com/python",
      title: "Learning Python",
      summary: "Python decorators explained",
      takeaway: "Decorators wrap functions",
      tags: ["python"],
    });
    const res = await t.request("/api/search?q=rust");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id)).toContain("s-1");
    expect(body.items.map((x) => x.id)).not.toContain("s-2");
  });

  it("sanitizes injected operators", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "sql-1",
      canonicalUrl: "https://example.com/sql",
      url: "https://example.com/sql",
      title: "SQL notes",
      summary: "join semantics",
      takeaway: "primary keys matter",
      tags: ["sql"],
    });
    // Would-be-broken FTS if unsanitized: `MATCH '"badtoken" NEAR *'`
    const res = await t.request(
      `/api/search?q=${encodeURIComponent('sql NEAR * "unclosed')}`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id)).toContain("sql-1");
  });

  it("keeps the EntryDTO response shape after the hybrid upgrade", async () => {
    const t = buildTestApp({ embedder: makeStubEmbedder([["rust"]], { dimensions: 4 }) });
    await insertEntry(t.deps.db, {
      id: "shape-1",
      canonicalUrl: "https://example.com/shape",
      url: "https://example.com/shape",
      title: "Rust notes",
      summary: "Rust ownership",
      takeaway: "Ownership matters",
      tags: ["rust"],
    });
    const res = await t.request("/api/search?q=rust");
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      "canonicalUrl",
      "createdAt",
      "error",
      "id",
      "question",
      "sourceDomain",
      "status",
      "summary",
      "tags",
      "takeaway",
      "title",
      "updatedAt",
      "url",
    ]);
  });

  it("surfaces a semantic-only hit that FTS alone would miss", async () => {
    const t = buildTestApp({
      embedder: makeStubEmbedder([["kubernetes", "pods", "cluster"]], {
        dimensions: 4,
      }),
    });
    await insertEntry(t.deps.db, {
      id: "k8s-1",
      canonicalUrl: "https://example.com/k8s",
      url: "https://example.com/k8s",
      title: "Pods and nodes",
      summary: "How the cluster places pods",
      takeaway: "Scoring plugins pick the node",
      tags: ["kubernetes"],
    });
    await indexEntry(t.deps, {
      id: "k8s-1",
      title: "Pods and nodes",
      summary: "How the cluster places pods",
      takeaway: "Scoring plugins pick the node",
      tags: ["kubernetes"],
      sourceDomain: "example.com",
      createdAt: 1_700_000_000_000,
    });

    const res = await t.request("/api/search?q=kubernetes");
    const body = (await res.json()) as { items: Array<{ id: string }> };
    expect(body.items.map((x) => x.id)).toEqual(["k8s-1"]);
  });

  it("caps limit at the chat tool ceiling", async () => {
    const t = buildTestApp();
    for (let i = 0; i < 25; i += 1) {
      await insertEntry(t.deps.db, {
        id: `many-${i}`,
        canonicalUrl: `https://example.com/many-${i}`,
        url: `https://example.com/many-${i}`,
        title: "Widget notes",
        summary: "widget widget",
        takeaway: "widgets",
        tags: ["widget"],
      });
    }
    const res = await t.request("/api/search?q=widget&limit=100");
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toHaveLength(20);
  });
});
