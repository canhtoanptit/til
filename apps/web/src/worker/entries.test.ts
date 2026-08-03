import { describe, expect, it } from "vitest";
import { buildTestApp, insertEntry } from "./test-harness.js";
import { entries } from "@til/db";
import { eq } from "drizzle-orm";

describe("POST /api/entries", () => {
  it("validates body — missing url → 422 validation_error", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("invalid url → 400 invalid_url", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "not-a-url" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_url");
  });

  it("unsafe url (metadata IP) → 400 unsafe_url", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://169.254.169.254/" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsafe_url");
  });

  it("localhost url → 400 unsafe_url", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:9000/x" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsafe_url");
  });

  it("valid url → 201 pending and schedules ingest", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/hello?utm_source=x" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.status).toBe("pending");
    expect(typeof body.id).toBe("string");
    await t.flush();
  });

  it("duplicate canonical url → 409 with existingId", async () => {
    const t = buildTestApp();
    const existingId = await insertEntry(t.deps.db, {
      id: "existing-1",
      canonicalUrl: "https://example.com/dup",
      url: "https://example.com/dup",
    });
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/dup" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string };
      existingId: string;
    };
    expect(body.error.code).toBe("duplicate_url");
    expect(body.existingId).toBe(existingId);
  });

  it("ingest happy path writes ready row", async () => {
    const t = buildTestApp();
    const { settings } = await import("@til/db");
    await t.deps.db.insert(settings).values({
      id: 1,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-live-1234",
      cfAccountId: "acc",
      cfGatewayId: "gw",
      cfAigToken: null,
      createdAt: 1,
      updatedAt: 1,
    });

    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/happy" }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    await t.flush();
    const rows = await t.deps.db.select().from(entries).where(eq(entries.id, id));
    const row = rows[0];
    expect(row?.status).toBe("ready");
    expect(row?.title).toBe("Stub Title");
    expect(row?.tags).toBe(JSON.stringify(["alpha", "beta", "gamma"]));
    expect(row?.contentMarkdown).toBe("hello world");
  });

  it("ingest marks failed when settings missing", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/sad" }),
    });
    const { id } = (await res.json()) as { id: string };
    await t.flush();
    const rows = await t.deps.db.select().from(entries).where(eq(entries.id, id));
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toContain("settings not configured");
  });
});

describe("GET /api/entries", () => {
  it("keyset paginates DESC by createdAt then id", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, {
      id: "a",
      createdAt: 100,
      updatedAt: 100,
      url: "https://example.com/a",
      canonicalUrl: "https://example.com/a",
    });
    await insertEntry(t.deps.db, {
      id: "b",
      createdAt: 200,
      updatedAt: 200,
      url: "https://example.com/b",
      canonicalUrl: "https://example.com/b",
    });
    await insertEntry(t.deps.db, {
      id: "c",
      createdAt: 300,
      updatedAt: 300,
      url: "https://example.com/c",
      canonicalUrl: "https://example.com/c",
    });
    const res = await t.request("/api/entries?limit=2");
    const body = (await res.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(body.items.map((x) => x.id)).toEqual(["c", "b"]);
    expect(body.nextCursor).toBe("200_b");

    const next = await t.request(`/api/entries?limit=2&cursor=${body.nextCursor}`);
    const nextBody = (await next.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(nextBody.items.map((x) => x.id)).toEqual(["a"]);
    expect(nextBody.nextCursor).toBeNull();
  });

  it("sweeps stale pending rows into failed", async () => {
    const now = 5_000_000_000;
    const staleAt = now - 11 * 60 * 1000;
    const t = buildTestApp({ now: () => now });
    await insertEntry(t.deps.db, {
      id: "stale",
      status: "pending",
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    const res = await t.request("/api/entries");
    const body = (await res.json()) as {
      items: Array<{ id: string; status: string; error: string | null }>;
    };
    const stale = body.items.find((x) => x.id === "stale");
    expect(stale?.status).toBe("failed");
    expect(stale?.error).toBe("ingest timed out");
  });

  it("sweeps a stale pending row on the detail route so polling terminates", async () => {
    const now = 5_000_000_000;
    const staleAt = now - 11 * 60 * 1000;
    const t = buildTestApp({ now: () => now });
    await insertEntry(t.deps.db, {
      id: "zombie",
      status: "pending",
      createdAt: staleAt,
      updatedAt: staleAt,
    });
    const res = await t.request("/api/entries/zombie");
    const body = (await res.json()) as { status: string; error: string | null };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("ingest timed out");
  });

  it("leaves a fresh pending row alone on the detail route", async () => {
    const now = 5_000_000_000;
    const t = buildTestApp({ now: () => now });
    await insertEntry(t.deps.db, {
      id: "fresh",
      status: "pending",
      createdAt: now - 1_000,
      updatedAt: now - 1_000,
    });
    const res = await t.request("/api/entries/fresh");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });
});

describe("GET /api/entries/:id", () => {
  it("returns detail with contentMarkdown or 404", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "detail-1" });
    const ok = await t.request("/api/entries/detail-1");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { id: string; contentMarkdown: string | null };
    expect(body.id).toBe("detail-1");
    expect("contentMarkdown" in body).toBe(true);

    const missing = await t.request("/api/entries/does-not-exist");
    expect(missing.status).toBe(404);
  });
});

describe("DELETE /api/entries/:id", () => {
  it("deletes and calls vectorize.deleteByIds", async () => {
    const calls: string[][] = [];
    const t = buildTestApp({
      vectorize: {
        upsert: async () => {},
        deleteByIds: async (ids) => {
          calls.push(ids);
        },
      },
    });
    await insertEntry(t.deps.db, { id: "del-1" });
    const res = await t.request("/api/entries/del-1", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(calls).toEqual([["del-1"]]);
  });

  it("404 when missing", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/entries/:id/reingest", () => {
  it("resets state to pending and returns 202", async () => {
    const t = buildTestApp();
    await insertEntry(t.deps.db, { id: "re-1", status: "failed" });
    // seed settings so ingest gets far enough
    const { settings } = await import("@til/db");
    await t.deps.db.insert(settings).values({
      id: 1,
      provider: "openai",
      model: "gpt-4o-mini",
      apiKey: "sk-live-1234",
      cfAccountId: "acc",
      cfGatewayId: "gw",
      cfAigToken: null,
      createdAt: 1,
      updatedAt: 1,
    });
    const res = await t.request("/api/entries/re-1/reingest", { method: "POST" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string; status: string };
    expect(body).toEqual({ id: "re-1", status: "pending" });
    await t.flush();
    const rows = await t.deps.db.select().from(entries).where(eq(entries.id, "re-1"));
    expect(rows[0]?.status).toBe("ready");
  });

  it("404 when missing", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries/missing/reingest", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

