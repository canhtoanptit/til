import { describe, expect, it, vi } from "vitest";
import { entries, entryVectors, settings } from "@til/db";
import { eq } from "drizzle-orm";
import { indexEntry, reembedEntries } from "./indexing.js";
import {
  buildTestApp,
  insertEntry,
  makeStubEmbedder,
  makeThrowingEmbedder,
} from "./test-harness.js";

const NOW = 1_700_000_000_000;
const TOPICS = [["alpha"], ["beta"]];

function embedder(onEmbed?: (texts: string[]) => void) {
  return makeStubEmbedder(TOPICS, {
    dimensions: 8,
    ...(onEmbed ? { onEmbed } : {}),
  });
}

async function seedSettings(
  db: Awaited<ReturnType<typeof buildTestApp>>["deps"]["db"],
) {
  await db.insert(settings).values({
    id: 1,
    provider: "openai",
    model: "gpt-4o-mini",
    apiKey: "sk-test",
    cfAccountId: "acct",
    cfGatewayId: "gw",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

describe("indexEntry", () => {
  it("writes a vector via the store", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, { id: "e-1", createdAt: NOW });
    const ok = await indexEntry(t.deps, {
      id: "e-1",
      title: "Alpha things",
      summary: "About alpha.",
      takeaway: "Alpha matters.",
      tags: ["alpha"],
      sourceDomain: "example.com",
      createdAt: NOW,
    });
    expect(ok).toBe(true);

    const rows = await t.deps.db.select().from(entryVectors);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      entryId: "e-1",
      embedModel: "stub-embed",
      dims: 8,
    });
  });

  it("returns false without an embedder instead of throwing", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, { id: "e-1", createdAt: NOW });
    await expect(
      indexEntry(t.deps, {
        id: "e-1",
        title: "T",
        summary: "S",
        takeaway: "K",
        tags: [],
        sourceDomain: null,
        createdAt: NOW,
      }),
    ).resolves.toBe(false);
  });

  it("swallows an embedder failure and logs it", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: makeThrowingEmbedder("ollama down"),
    });
    await insertEntry(t.deps.db, { id: "e-1", createdAt: NOW });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      indexEntry(t.deps, {
        id: "e-1",
        title: "T",
        summary: "S",
        takeaway: "K",
        tags: [],
        sourceDomain: null,
        createdAt: NOW,
      }),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[index e-1]"),
      expect.stringContaining("ollama down"),
    );
    warn.mockRestore();
  });

  it("skips an entry with no embeddable text", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, { id: "e-1", createdAt: NOW });
    await expect(
      indexEntry(t.deps, {
        id: "e-1",
        title: null,
        summary: null,
        takeaway: null,
        tags: [],
        sourceDomain: null,
        createdAt: NOW,
      }),
    ).resolves.toBe(false);
    await expect(t.deps.db.select().from(entryVectors)).resolves.toEqual([]);
  });
});

describe("ingest indexing", () => {
  it("reaches ready and indexes the entry", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await seedSettings(t.deps.db);
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/alpha" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await t.flush();

    const rows = await t.deps.db
      .select()
      .from(entries)
      .where(eq(entries.id, id));
    expect(rows[0]?.status).toBe("ready");
    const vectors = await t.deps.db.select().from(entryVectors);
    expect(vectors.map((v) => v.entryId)).toEqual([id]);
  });

  it("still reaches ready when embedding fails", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: makeThrowingEmbedder(),
    });
    await seedSettings(t.deps.db);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/alpha" }),
    });
    const { id } = (await res.json()) as { id: string };
    await t.flush();
    warn.mockRestore();

    const rows = await t.deps.db
      .select()
      .from(entries)
      .where(eq(entries.id, id));
    expect(rows[0]?.status).toBe("ready");
    expect(rows[0]?.error).toBeNull();
    await expect(t.deps.db.select().from(entryVectors)).resolves.toEqual([]);
  });
});

describe("POST /api/entries/reembed", () => {
  it("embeds ready entries that have no vector", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    await insertEntry(t.deps.db, {
      id: "r-2",
      canonicalUrl: "https://x/2",
      createdAt: NOW,
    });

    const res = await t.request("/api/entries/reembed", { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      embedded: 2,
      skipped: 0,
      failed: 0,
    });
    const vectors = await t.deps.db.select().from(entryVectors);
    expect(vectors.map((v) => v.entryId).sort()).toEqual(["r-1", "r-2"]);
  });

  it("skips entries that are already indexed with the current model", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    await t.request("/api/entries/reembed", { method: "POST" });

    const res = await t.request("/api/entries/reembed", { method: "POST" });
    await expect(res.json()).resolves.toEqual({
      embedded: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it("re-embeds an entry whose digest changed after it was indexed", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    await t.request("/api/entries/reembed", { method: "POST" });
    await t.deps.db
      .update(entries)
      .set({ takeaway: "Now about beta.", updatedAt: NOW + 60_000 })
      .where(eq(entries.id, "r-1"));

    const res = await t.request("/api/entries/reembed", { method: "POST" });
    await expect(res.json()).resolves.toEqual({
      embedded: 1,
      skipped: 0,
      failed: 0,
    });
  });

  it("ignores entries that are not ready", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, {
      id: "p-1",
      canonicalUrl: "https://x/p",
      createdAt: NOW,
      status: "pending",
    });
    await insertEntry(t.deps.db, {
      id: "f-1",
      canonicalUrl: "https://x/f",
      createdAt: NOW,
      status: "failed",
    });
    const res = await t.request("/api/entries/reembed", { method: "POST" });
    await expect(res.json()).resolves.toEqual({
      embedded: 0,
      skipped: 0,
      failed: 0,
    });
  });

  it("counts every entry as skipped when there is no embedder", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    const res = await t.request("/api/entries/reembed", { method: "POST" });
    await expect(res.json()).resolves.toEqual({
      embedded: 0,
      skipped: 1,
      failed: 0,
    });
  });

  it("counts a failing batch as failed and keeps the entries intact", async () => {
    const t = buildTestApp({
      now: () => NOW,
      embedder: makeThrowingEmbedder(),
    });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await t.request("/api/entries/reembed", { method: "POST" });
    warn.mockRestore();
    await expect(res.json()).resolves.toEqual({
      embedded: 0,
      skipped: 0,
      failed: 1,
    });
  });

  it("batches embedding calls rather than one call per entry", async () => {
    const calls: string[][] = [];
    const t = buildTestApp({
      now: () => NOW,
      embedder: embedder((texts) => calls.push(texts)),
    });
    for (let i = 0; i < 20; i += 1) {
      await insertEntry(t.deps.db, {
        id: `b-${i}`,
        canonicalUrl: `https://x/b-${i}`,
        createdAt: NOW,
      });
    }
    await reembedEntries(t.deps, {});
    expect(calls).toHaveLength(2);
    expect(calls[0]).toHaveLength(16);
    expect(calls[1]).toHaveLength(4);
  });

  it("is bounded by the max entries per call", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    await insertEntry(t.deps.db, {
      id: "r-1",
      canonicalUrl: "https://x/1",
      createdAt: NOW,
    });
    const result = await reembedEntries(t.deps, { limit: 9_999 });
    expect(result.embedded).toBe(1);
  });

  it("requires the bearer token", async () => {
    const t = buildTestApp({ now: () => NOW, embedder: embedder() });
    const res = await t.request("/api/entries/reembed", {
      method: "POST",
      auth: false,
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/health", () => {
  it("reports the local stack and an available embedder", async () => {
    const t = buildTestApp({ embedder: embedder() });
    const res = await t.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      stack: "local",
      embedder: "ok",
    });
  });

  it("reports unavailable when no embedder is reachable", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/health", { auth: false });
    await expect(res.json()).resolves.toEqual({
      ok: true,
      stack: "local",
      embedder: "unavailable",
    });
  });

  it("reports the cloud stack", async () => {
    const t = buildTestApp({ stack: "cloud", embedder: embedder() });
    const res = await t.request("/api/health", { auth: false });
    await expect(res.json()).resolves.toEqual({
      ok: true,
      stack: "cloud",
      embedder: "ok",
    });
  });

  it("never propagates a throwing probe", async () => {
    const t = buildTestApp({
      probeEmbedder: async () => {
        throw new Error("probe exploded");
      },
    });
    const res = await t.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      stack: "local",
      embedder: "unavailable",
    });
  });
});
