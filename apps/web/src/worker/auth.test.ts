import { describe, expect, it } from "vitest";
import { sessions } from "@til/db";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./session.js";
import { buildTestApp } from "./test-harness.js";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);

describe("session middleware", () => {
  it("permits /api/health without a session", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("rejects a protected route with no cookie", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a session id that matches no row", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", {
      auth: false,
      headers: { cookie: `${SESSION_COOKIE}=${"f".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts the session cookie", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries");
    expect(res.status).toBe(200);
  });

  // The pre-M5 client still sends a bearer header; the cookie alone decides.
  it("ignores an Authorization header entirely", async () => {
    const t = buildTestApp();
    const withToken = await t.request("/api/entries", {
      auth: false,
      headers: { authorization: "Bearer dev-token" },
    });
    expect(withToken.status).toBe(401);

    const withBoth = await t.request("/api/entries", {
      headers: { authorization: "Bearer nonsense" },
    });
    expect(withBoth.status).toBe(200);
  });

  it("resolves a different cookie to a different user", async () => {
    const t = buildTestApp();
    const alice = await t.request("/api/auth/me", { user: "alice" });
    expect(await alice.json()).toMatchObject({
      id: "alice",
      email: "alice@test.local",
    });
    const owner = await t.request("/api/auth/me");
    expect(await owner.json()).toMatchObject({ id: "owner" });
  });

  it("rejects an expired session and sweeps the dead row", async () => {
    let clock = NOW;
    const t = buildTestApp({ now: () => clock });
    const { cookie, sessionId } = await t.loginAs("alice@example.com");

    const before = await t.request("/api/entries", {
      auth: false,
      headers: { cookie },
    });
    expect(before.status).toBe(200);

    clock = NOW + SESSION_TTL_MS + 1;
    const after = await t.request("/api/entries", {
      auth: false,
      headers: { cookie },
    });
    expect(after.status).toBe(401);

    const rows = await t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    expect(rows).toHaveLength(0);
  });

  it("lets a non-/api path through to the SPA fallback", async () => {
    const t = buildTestApp();
    const res = await t.request("/nope", { auth: false });
    expect(res.status).toBe(404);
  });
});
