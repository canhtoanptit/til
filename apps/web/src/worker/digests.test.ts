import { describe, expect, it } from "vitest";
import { digestItems, digests } from "@til/db";
import { eq } from "drizzle-orm";
import {
  buildTestApp,
  createRecordingWorkflow,
  insertDigest,
  insertDigestItem,
} from "./test-harness.js";
import type { DigestDetailDTO, DigestSummaryDTO } from "./dto.js";

const NOW = 1_700_000_000_000;

describe("POST /api/digests/run", () => {
  it("creates a pending row, triggers the workflow, and returns 202 with the row id", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({
      digestWorkflow: workflow.binding,
      now: () => NOW,
    });

    const res = await t.request("/api/digests/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string };
    expect(typeof body.id).toBe("string");

    const rows = await t.deps.db
      .select()
      .from(digests)
      .where(eq(digests.id, body.id));
    expect(rows[0]?.status).toBe("pending");
    expect(rows[0]?.runAt).toBe(NOW);
    expect(rows[0]?.windowDays).toBe(7);

    expect(workflow.created).toHaveLength(1);
    expect(workflow.created[0]?.id).toBe(body.id);
    expect(workflow.created[0]?.params).toEqual({
      digestId: body.id,
      windowDays: 7,
      maxItems: 10,
      now: NOW,
    });
  });

  it("accepts an empty body (cron-style defaults)", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({ digestWorkflow: workflow.binding });
    const res = await t.request("/api/digests/run", { method: "POST" });
    expect(res.status).toBe(202);
    expect(workflow.created[0]?.params?.windowDays).toBe(7);
    expect(workflow.created[0]?.params?.maxItems).toBe(10);
  });

  it("honours windowDays and maxItems overrides", async () => {
    const workflow = createRecordingWorkflow();
    const t = buildTestApp({ digestWorkflow: workflow.binding });
    const res = await t.request("/api/digests/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays: 14, maxItems: 3 }),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { id: string };
    const rows = await t.deps.db
      .select()
      .from(digests)
      .where(eq(digests.id, body.id));
    expect(rows[0]?.windowDays).toBe(14);
    expect(workflow.created[0]?.params?.windowDays).toBe(14);
    expect(workflow.created[0]?.params?.maxItems).toBe(3);
  });

  it("rejects out-of-range params → 422 validation_error", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/digests/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ windowDays: 99 }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects malformed JSON → 422 validation_error", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/digests/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("missing DIGEST binding → 503 workflow_error and no row", async () => {
    const t = buildTestApp({ digestWorkflow: null });
    const res = await t.request("/api/digests/run", { method: "POST" });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_error");
    const rows = await t.deps.db.select().from(digests);
    expect(rows).toHaveLength(0);
  });

  it("workflow trigger failure → 502 and the row is marked failed", async () => {
    const workflow = createRecordingWorkflow(() => {
      throw new Error("workflows unavailable");
    });
    const t = buildTestApp({ digestWorkflow: workflow.binding });
    const res = await t.request("/api/digests/run", { method: "POST" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workflow_error");

    const rows = await t.deps.db.select().from(digests);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.error).toContain("workflows unavailable");
  });
});

describe("GET /api/digests", () => {
  it("lists runs newest-first with item counts", async () => {
    const t = buildTestApp({ now: () => NOW });
    const older = await insertDigest(t.deps.db, {
      id: "older",
      runAt: NOW - 1000,
      title: "Older digest",
    });
    const newer = await insertDigest(t.deps.db, {
      id: "newer",
      runAt: NOW,
      title: "Newer digest",
    });
    await insertDigestItem(t.deps.db, newer, { rank: 1 });
    await insertDigestItem(t.deps.db, newer, { rank: 2 });

    const res = await t.request("/api/digests");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: DigestSummaryDTO[] };
    expect(body.items.map((i) => i.id)).toEqual([newer, older]);
    expect(body.items[0]?.itemCount).toBe(2);
    expect(body.items[1]?.itemCount).toBe(0);
    expect(body.items[0]?.title).toBe("Newer digest");
  });

  it("respects ?limit", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertDigest(t.deps.db, { id: "a", runAt: NOW - 2 });
    await insertDigest(t.deps.db, { id: "b", runAt: NOW - 1 });
    await insertDigest(t.deps.db, { id: "c", runAt: NOW });

    const res = await t.request("/api/digests?limit=2");
    const body = (await res.json()) as { items: DigestSummaryDTO[] };
    expect(body.items.map((i) => i.id)).toEqual(["c", "b"]);
  });

  it("sweeps stale pending runs to failed", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertDigest(t.deps.db, {
      id: "stuck",
      status: "pending",
      title: null,
      intro: null,
      runAt: NOW - 60 * 60 * 1000,
      updatedAt: NOW - 60 * 60 * 1000,
    });
    await insertDigest(t.deps.db, {
      id: "fresh",
      status: "pending",
      title: null,
      intro: null,
      runAt: NOW - 1000,
      updatedAt: NOW - 1000,
    });

    const res = await t.request("/api/digests");
    const body = (await res.json()) as { items: DigestSummaryDTO[] };
    const byId = new Map(body.items.map((i) => [i.id, i]));
    expect(byId.get("stuck")?.status).toBe("failed");
    expect(byId.get("stuck")?.error).toBe("digest run timed out");
    expect(byId.get("fresh")?.status).toBe("pending");
  });
});

describe("GET /api/digests/:id", () => {
  it("sweeps a stale pending run so detail polling terminates", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertDigest(t.deps.db, {
      id: "zombie",
      status: "pending",
      title: null,
      intro: null,
      runAt: NOW - 60 * 60 * 1000,
      updatedAt: NOW - 60 * 60 * 1000,
    });
    const res = await t.request("/api/digests/zombie");
    const body = (await res.json()) as { status: string; error: string | null };
    expect(body.status).toBe("failed");
    expect(body.error).toBe("digest run timed out");
  });

  it("leaves a fresh pending run alone on the detail route", async () => {
    const t = buildTestApp({ now: () => NOW });
    await insertDigest(t.deps.db, {
      id: "running",
      status: "pending",
      title: null,
      intro: null,
      runAt: NOW - 5_000,
      updatedAt: NOW - 5_000,
    });
    const res = await t.request("/api/digests/running");
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending");
  });

  it("returns ordered items with parsed evidence", async () => {
    const t = buildTestApp({ now: () => NOW });
    const id = await insertDigest(t.deps.db, { id: "d1" });
    await insertDigestItem(t.deps.db, id, {
      rank: 2,
      title: "Second",
      url: "https://example.com/second",
      score: 0.4,
    });
    await insertDigestItem(t.deps.db, id, {
      rank: 1,
      title: "First",
      url: "https://example.com/first",
      score: 0.9,
      evidence: [
        {
          url: "https://news.ycombinator.com/item?id=1",
          sourceName: "hn",
          title: "First",
        },
        {
          url: "https://lobste.rs/s/abc",
          sourceName: "lobsters",
          title: "First!",
        },
      ],
    });

    const res = await t.request("/api/digests/d1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as DigestDetailDTO;
    expect(body.itemCount).toBe(2);
    expect(body.items.map((i) => i.rank)).toEqual([1, 2]);
    expect(body.items[0]?.title).toBe("First");
    expect(body.items[0]?.score).toBeCloseTo(0.9);
    expect(body.items[0]?.evidence).toEqual([
      {
        url: "https://news.ycombinator.com/item?id=1",
        sourceName: "hn",
        title: "First",
      },
      {
        url: "https://lobste.rs/s/abc",
        sourceName: "lobsters",
        title: "First!",
      },
    ]);
    expect(body.items[1]?.evidence).toEqual([]);
  });

  it("unknown id → 404 not_found", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/digests/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

describe("DELETE /api/digests/:id", () => {
  it("deletes the run and cascades its items", async () => {
    const t = buildTestApp();
    const id = await insertDigest(t.deps.db, { id: "gone" });
    await insertDigestItem(t.deps.db, id, { rank: 1 });
    await insertDigestItem(t.deps.db, id, { rank: 2 });

    const res = await t.request("/api/digests/gone", { method: "DELETE" });
    expect(res.status).toBe(204);

    expect(await t.deps.db.select().from(digests)).toHaveLength(0);
    expect(await t.deps.db.select().from(digestItems)).toHaveLength(0);
  });

  it("unknown id → 404 not_found", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/digests/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("digest route auth", () => {
  const cases: { path: string; method: string }[] = [
    { path: "/api/digests", method: "GET" },
    { path: "/api/digests/some-id", method: "GET" },
    { path: "/api/digests/run", method: "POST" },
    { path: "/api/digests/some-id", method: "DELETE" },
  ];

  for (const { path, method } of cases) {
    it(`${method} ${path} without a token → 401`, async () => {
      const t = buildTestApp();
      const res = await t.request(path, { method, auth: false });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("unauthorized");
    });
  }
});
