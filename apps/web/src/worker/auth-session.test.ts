import { describe, expect, it } from "vitest";
import { sessions, users } from "@til/db";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE } from "./session.js";
import type { TestApp } from "./test-harness.js";
import { TEST_SESSION_ID, buildTestApp } from "./test-harness.js";

const DEFAULT_COOKIE = `${SESSION_COOKIE}=${TEST_SESSION_ID}`;

function setCookieNamed(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
}

function devLogin(
  t: TestApp,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  return t.request("/api/auth/dev-login", {
    auth: false,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });
}

describe("GET /api/auth/me", () => {
  it("401s without a session", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/auth/me", { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns the signed-in identity", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/auth/me");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "owner",
      email: "owner@test.local",
      name: "Owner",
      picture: null,
    });
  });
});

describe("POST /api/auth/logout", () => {
  it("deletes the session, clears the cookie and cannot be replayed", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);

    const cleared = setCookieNamed(res, SESSION_COOKIE);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");

    const rows = await t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, TEST_SESSION_ID));
    expect(rows).toHaveLength(0);

    const replay = await t.request("/api/entries", {
      auth: false,
      headers: { cookie: DEFAULT_COOKIE },
    });
    expect(replay.status).toBe(401);
  });

  it("204s without a session cookie", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/auth/logout", {
      auth: false,
      method: "POST",
    });
    expect(res.status).toBe(204);
  });
});

describe("POST /api/auth/dev-login", () => {
  it("signs a local developer in and sets a session cookie", async () => {
    const t = buildTestApp();
    const res = await devLogin(t, { email: "dev@example.com" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string; email: string };
    expect(body.email).toBe("dev@example.com");
    expect(body.id).not.toBe("owner");

    const cookie = setCookieNamed(res, SESSION_COOKIE);
    const sid = cookie?.slice(`${SESSION_COOKIE}=`.length).split(";")[0] ?? "";
    expect(sid).toMatch(/^[0-9a-f]{64}$/);

    const me = await t.request("/api/auth/me", {
      auth: false,
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(await me.json()).toMatchObject({ id: body.id });
  });

  it("reuses the same user across repeat logins", async () => {
    const t = buildTestApp();
    await devLogin(t, { email: "dev@example.com" });
    await devLogin(t, { email: "dev@example.com" });

    const rows = await t.deps.db
      .select()
      .from(users)
      .where(eq(users.googleSub, "dev:dev@example.com"));
    expect(rows).toHaveLength(1);

    const open = await t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, rows[0]?.id ?? ""));
    expect(open).toHaveLength(2);
  });

  it("claims the owner row when the email matches OWNER_EMAIL", async () => {
    const t = buildTestApp();
    t.sqlite.exec(
      "update users set google_sub = null, email = 'owner@placeholder.invalid' where id = 'owner'",
    );
    const res = await devLogin(t, { email: "owner@test.local" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: "owner",
      email: "owner@test.local",
    });
    expect(await t.deps.db.select().from(users)).toHaveLength(1);
  });

  it("does not exist outside a local stack", async () => {
    const t = buildTestApp({ env: { TIL_STACK: "cloud" } });
    const res = await devLogin(t, { email: "dev@example.com" });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
    expect(await t.deps.db.select().from(users)).toHaveLength(1);
  });

  it("422s a body that is not an email", async () => {
    const t = buildTestApp();
    for (const body of [{ email: "not-an-address" }, {}]) {
      const res = await devLogin(t, body);
      expect(res.status).toBe(422);
      const parsed = (await res.json()) as { error: { code: string } };
      expect(parsed.error.code).toBe("validation_error");
    }
  });
});
