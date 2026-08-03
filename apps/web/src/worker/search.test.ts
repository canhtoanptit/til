import { describe, expect, it } from "vitest";
import { buildTestApp, insertEntry } from "./test-harness.js";
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
});
