import { describe, expect, it, vi } from "vitest";
import type { Embedder, VectorStore } from "@til/core";
import { buildTestApp, insertEntry, makeStubEmbedder } from "./test-harness.js";
import { indexEntry } from "./indexing.js";
import type { Deps } from "./deps.js";
import type { RelatedEntriesDTO } from "./dto.js";

const DIMS = 4;

/** One axis per topic, so "same topic" entries land on the same unit vector. */
function embedder(): Embedder {
  return makeStubEmbedder(
    [
      ["kubernetes", "pods", "cluster"],
      ["css", "flexbox", "grid"],
      ["rust", "ownership", "borrow"],
    ],
    { dimensions: DIMS },
  );
}

interface Seed {
  id: string;
  title: string;
  summary: string;
  takeaway: string;
  tags: string[];
  domain?: string;
}

async function seed(deps: Deps, entries: Seed[]): Promise<void> {
  for (const entry of entries) {
    await insertEntry(deps.db, {
      id: entry.id,
      canonicalUrl: `https://${entry.domain ?? "example.com"}/${entry.id}`,
      url: `https://${entry.domain ?? "example.com"}/${entry.id}`,
      title: entry.title,
      summary: entry.summary,
      takeaway: entry.takeaway,
      tags: entry.tags,
      sourceDomain: entry.domain ?? "example.com",
    });
    await indexEntry(deps, {
      userId: "owner",
      id: entry.id,
      title: entry.title,
      summary: entry.summary,
      takeaway: entry.takeaway,
      tags: entry.tags,
      sourceDomain: entry.domain ?? "example.com",
      createdAt: 1_700_000_000_000,
    });
  }
}

const K8S: Seed[] = [
  {
    id: "k8s-1",
    title: "Pods and nodes",
    summary: "How the cluster places pods",
    takeaway: "Scoring plugins pick the node",
    tags: ["kubernetes"],
    domain: "k8s.example",
  },
  {
    id: "k8s-2",
    title: "Cluster autoscaling",
    summary: "The cluster adds nodes for pending pods",
    takeaway: "Autoscaling reacts to unschedulable pods",
    tags: ["kubernetes"],
    domain: "k8s.example",
  },
];

const CSS: Seed = {
  id: "css-1",
  title: "Flexbox notes",
  summary: "css flexbox alignment",
  takeaway: "align-items is the cross axis",
  tags: ["css"],
  domain: "css.example",
};

describe("GET /api/entries/:id/related", () => {
  it("404s for an entry that does not exist", async () => {
    const t = buildTestApp({ embedder: embedder() });
    const res = await t.request("/api/entries/nope/related");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("returns the neighbours of an indexed entry, closest first, without itself", async () => {
    const t = buildTestApp({ embedder: embedder() });
    await seed(t.deps, [...K8S, CSS]);

    const res = await t.request("/api/entries/k8s-1/related");
    expect(res.status).toBe(200);
    const body = (await res.json()) as RelatedEntriesDTO;
    expect(body.available).toBe(true);
    expect(body.items.map((item) => item.id)).toEqual(["k8s-2", "css-1"]);
    // Closest first, and the entry itself is never in its own related list.
    expect(body.items[0]?.score).toBeGreaterThan(body.items[1]?.score ?? 1);
    expect(body.items.map((item) => item.id)).not.toContain("k8s-1");
  });

  it("hydrates exactly {id,title,sourceDomain,takeaway,score}", async () => {
    const t = buildTestApp({ embedder: embedder() });
    await seed(t.deps, K8S);

    const res = await t.request("/api/entries/k8s-1/related");
    const body = (await res.json()) as { items: Record<string, unknown>[] };
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      "id",
      "score",
      "sourceDomain",
      "takeaway",
      "title",
    ]);
    expect(body.items[0]).toMatchObject({
      id: "k8s-2",
      title: "Cluster autoscaling",
      sourceDomain: "k8s.example",
      takeaway: "Autoscaling reacts to unschedulable pods",
    });
  });

  it("bounds limit: default 5, clamped to 1..20, garbage falls back to the default", async () => {
    const t = buildTestApp({ embedder: embedder() });
    const many: Seed[] = [];
    for (let i = 0; i < 8; i += 1) {
      many.push({
        id: `k8s-${i}`,
        title: `Cluster note ${i}`,
        summary: "the cluster schedules pods",
        takeaway: "pods land on nodes",
        tags: ["kubernetes"],
      });
    }
    await seed(t.deps, many);

    const read = async (query: string) => {
      const res = await t.request(`/api/entries/k8s-0/related${query}`);
      expect(res.status).toBe(200);
      return (await res.json()) as RelatedEntriesDTO;
    };

    expect((await read("")).items).toHaveLength(5);
    expect((await read("?limit=2")).items).toHaveLength(2);
    expect((await read("?limit=0")).items).toHaveLength(1);
    expect((await read("?limit=-4")).items).toHaveLength(1);
    // 7 neighbours exist, so a clamp to 20 shows as "all of them".
    expect((await read("?limit=999")).items).toHaveLength(7);
    expect((await read("?limit=abc")).items).toHaveLength(5);
  });

  it("says available:false when the entry has no vector", async () => {
    const t = buildTestApp({ embedder: embedder() });
    // Indexed neighbours exist; this entry itself was never embedded.
    await seed(t.deps, K8S);
    await insertEntry(t.deps.db, {
      id: "unindexed",
      canonicalUrl: "https://example.com/unindexed",
      url: "https://example.com/unindexed",
      title: "Never embedded",
    });

    const res = await t.request("/api/entries/unindexed/related");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ available: false, items: [] });
  });

  it("says available:false when no vector store is configured", async () => {
    const t = buildTestApp({ embedder: null, vectorStore: null });
    await insertEntry(t.deps.db, {
      id: "solo",
      canonicalUrl: "https://example.com/solo",
      url: "https://example.com/solo",
    });

    const res = await t.request("/api/entries/solo/related");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ available: false, items: [] });
  });

  it("says available:true with no items when the entry is the whole corpus", async () => {
    const t = buildTestApp({ embedder: embedder() });
    await seed(t.deps, [CSS]);

    const res = await t.request("/api/entries/css-1/related");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ available: true, items: [] });
  });

  it("skips a match whose entry row is gone (an orphaned Vectorize vector)", async () => {
    const t = buildTestApp({ embedder: embedder() });
    await seed(t.deps, K8S);
    const real = t.deps.vectorStore;
    if (!real) throw new Error("expected a vector store");
    t.deps.vectorStore = {
      getVector: (id) => real.getVector(id),
      query: async (values, opts) => [
        ...(await real.query(values, opts)),
        { id: "ghost", score: 0.1 },
      ],
      upsert: (vectors) => real.upsert(vectors),
      deleteByIds: (ids) => real.deleteByIds(ids),
    } satisfies VectorStore;

    const res = await t.request("/api/entries/k8s-1/related");
    const body = (await res.json()) as RelatedEntriesDTO;
    expect(body.items.map((item) => item.id)).toEqual(["k8s-2"]);
  });

  it("degrades to available:false instead of 500 when the store throws", async () => {
    const t = buildTestApp({ embedder: embedder() });
    await seed(t.deps, K8S);
    t.deps.vectorStore = {
      getVector: async () => {
        throw new Error("vectorize unreachable");
      },
      query: async () => [],
      upsert: async () => {},
      deleteByIds: async () => {},
    } satisfies VectorStore;

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await t.request("/api/entries/k8s-1/related");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ available: false, items: [] });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[related k8s-1] vector lookup failed"),
      "vectorize unreachable",
    );
    warn.mockRestore();
  });
});
