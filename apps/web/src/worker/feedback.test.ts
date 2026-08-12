import { describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { entries, feedback } from "@til/db";
import { buildTestApp, insertEntry } from "./test-harness.js";
import type { FeedbackDTO } from "./dto.js";
import { MAX_FEEDBACK_COMMENT } from "./schemas.js";

const NOW = 1_700_000_000_000;

function post(
  t: ReturnType<typeof buildTestApp>,
  body: unknown,
  opts: { auth?: boolean } = {},
) {
  return t.request("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...(opts.auth === false ? { auth: false } : {}),
  });
}

describe("POST /api/feedback", () => {
  it("stores a chat vote and returns the created row as a DTO", async () => {
    const t = buildTestApp({ now: () => NOW });

    const res = await post(t, {
      kind: "up",
      conversationId: "conv-1",
      messageId: "msg-1",
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as FeedbackDTO;
    expect(body).toEqual({
      id: expect.any(String),
      conversationId: "conv-1",
      messageId: "msg-1",
      entryId: null,
      kind: "up",
      comment: null,
      createdAt: NOW,
    });

    const rows = await t.deps.db.select().from(feedback);
    expect(rows).toHaveLength(1);
    // The response must be exactly what was written, not a hopeful echo.
    expect(rows[0]).toEqual({
      id: body.id,
      conversationId: "conv-1",
      messageId: "msg-1",
      entryId: null,
      kind: "up",
      comment: null,
      createdAt: NOW,
    });
  });

  it("accepts a down vote", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await post(t, { kind: "down", messageId: "msg-2" });
    expect(res.status).toBe(201);
    expect((await res.json()) as FeedbackDTO).toMatchObject({
      kind: "down",
      messageId: "msg-2",
      conversationId: null,
    });
  });

  it("accepts an entry vote with a comment", async () => {
    const t = buildTestApp({ now: () => NOW });
    const entryId = await insertEntry(t.deps.db, { id: "e-1" });

    const res = await post(t, {
      kind: "down",
      entryId,
      comment: "The takeaway missed the point of the article.",
    });

    expect(res.status).toBe(201);
    expect((await res.json()) as FeedbackDTO).toMatchObject({
      entryId,
      kind: "down",
      comment: "The takeaway missed the point of the article.",
      conversationId: null,
      messageId: null,
    });
  });

  it("accepts a vote with kind alone — every reference is optional", async () => {
    const t = buildTestApp({ now: () => NOW });
    const res = await post(t, { kind: "up" });
    expect(res.status).toBe(201);
    const row = (await t.deps.db.select().from(feedback))[0];
    expect(row).toMatchObject({
      conversationId: null,
      messageId: null,
      entryId: null,
      comment: null,
    });
  });

  it("appends one row per vote, so a corrected vote keeps both in order", async () => {
    let clock = NOW;
    const t = buildTestApp({ now: () => clock });

    await post(t, { kind: "up", conversationId: "c", messageId: "m" });
    clock = NOW + 5_000;
    await post(t, { kind: "down", conversationId: "c", messageId: "m" });

    const rows = await t.deps.db
      .select()
      .from(feedback)
      .orderBy(asc(feedback.createdAt));
    expect(rows.map((r) => r.kind)).toEqual(["up", "down"]);
    expect(rows.map((r) => r.createdAt)).toEqual([NOW, NOW + 5_000]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  it("timestamps from deps.now(), not the wall clock", async () => {
    const t = buildTestApp({ now: () => 42 });
    await post(t, { kind: "up" });
    expect((await t.deps.db.select().from(feedback))[0]?.createdAt).toBe(42);
  });

  it("does not check that entryId exists, and the row survives the entry", async () => {
    // The no-foreign-key decision, stated as behaviour: a signal about a deleted
    // entry is still a signal, and DELETE /api/entries/:id must keep working.
    const t = buildTestApp({ now: () => NOW });
    const entryId = await insertEntry(t.deps.db, { id: "e-doomed" });
    await post(t, { kind: "down", entryId });
    await post(t, { kind: "up", entryId: "never-existed" });

    const del = await t.request(`/api/entries/${entryId}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect(await t.deps.db.select().from(entries)).toHaveLength(0);

    const rows = await t.deps.db.select().from(feedback);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.entryId).sort()).toEqual([
      "e-doomed",
      "never-existed",
    ]);
  });

  it("rejects an unknown kind", async () => {
    const t = buildTestApp();
    const res = await post(t, { kind: "meh", messageId: "m" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toMatch(/kind/i);
    expect(await t.deps.db.select().from(feedback)).toHaveLength(0);
  });

  it.each([
    ["a missing kind", { messageId: "m" }],
    ["an empty body", {}],
    ["a non-object body", "up"],
    ["an empty messageId", { kind: "up", messageId: "" }],
    ["an empty comment", { kind: "up", comment: "" }],
    ["a non-string comment", { kind: "up", comment: 7 }],
  ])("rejects %s", async (_label, body) => {
    const t = buildTestApp();
    const res = await post(t, body);
    expect(res.status).toBe(422);
    expect(await t.deps.db.select().from(feedback)).toHaveLength(0);
  });

  it("rejects a comment past the cap but accepts one at it", async () => {
    const t = buildTestApp({ now: () => NOW });
    const atCap = "x".repeat(MAX_FEEDBACK_COMMENT);

    expect((await post(t, { kind: "up", comment: atCap })).status).toBe(201);
    expect(
      (await post(t, { kind: "up", comment: `${atCap}x` })).status,
    ).toBe(422);

    const rows = await t.deps.db.select().from(feedback);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.comment).toHaveLength(MAX_FEEDBACK_COMMENT);
  });

  it("requires the app token", async () => {
    const t = buildTestApp();
    const res = await post(t, { kind: "up" }, { auth: false });
    expect(res.status).toBe(401);
    expect(await t.deps.db.select().from(feedback)).toHaveLength(0);
  });
});
