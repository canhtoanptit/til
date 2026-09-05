import { describe, expect, it } from "vitest";
import { sessions, users } from "@til/db";
import { eq } from "drizzle-orm";
import { STATE_COOKIE, validateGoogleClaims } from "./google-oauth.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./session.js";
import type { TestApp, TestOverrides } from "./test-harness.js";
import { buildTestApp } from "./test-harness.js";

const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const CLIENT_ID = "test-client-id";
const STATE = "0123456789abcdef";

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** header.payload.signature — the signature is never checked (ADR-0013). */
function makeIdToken(claims: Record<string, unknown>): string {
  return [
    base64url(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    base64url(JSON.stringify(claims)),
    "not-a-real-signature",
  ].join(".");
}

function googleClaims(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: Math.floor(NOW / 1000) + 3600,
    sub: "google-sub-1",
    email: "person@example.com",
    email_verified: true,
    // Non-ASCII on purpose: the payload is decoded as UTF-8, not latin-1.
    name: "Ana Müller",
    picture: "https://example.com/ana.png",
    ...overrides,
  };
}

interface OAuthHarness {
  t: TestApp;
  calls: { url: string; body: URLSearchParams }[];
  setClaims: (claims: Record<string, unknown>) => void;
  setResponse: (respond: () => Response) => void;
}

function buildOAuthApp(
  overrides: { env?: TestOverrides["env"] } = {},
): OAuthHarness {
  let claims = googleClaims();
  let respond = (): Response =>
    Response.json({ id_token: makeIdToken(claims) });
  const calls: { url: string; body: URLSearchParams }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(
        typeof init?.body === "string" ? init.body : "",
      ),
    });
    return respond();
  }) as unknown as typeof fetch;
  const t = buildTestApp({
    now: () => NOW,
    fetchImpl,
    ...(overrides.env ? { env: overrides.env } : {}),
  });
  return {
    t,
    calls,
    setClaims: (next) => {
      claims = next;
    },
    setResponse: (next) => {
      respond = next;
    },
  };
}

function callback(
  t: TestApp,
  opts: { query?: string; cookie?: string | null } = {},
): Promise<Response> {
  const query = opts.query ?? `?code=abc&state=${STATE}`;
  const cookie =
    opts.cookie === undefined ? `${STATE_COOKIE}=${STATE}` : opts.cookie;
  return t.request(`/api/auth/callback${query}`, {
    auth: false,
    ...(cookie === null ? {} : { headers: { cookie } }),
  });
}

function setCookieNamed(res: Response, name: string): string | undefined {
  return res.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`));
}

describe("GET /api/auth/google", () => {
  it("redirects to Google and plants a matching state cookie", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/auth/google", { auth: false });
    expect(res.status).toBe(302);

    const location = new URL(res.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      "http://test.local/api/auth/callback",
    );
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("scope")).toBe("openid email profile");

    const cookie = setCookieNamed(res, STATE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/api/auth");
    expect(cookie).toContain("Max-Age=600");
    expect(cookie).toContain("SameSite=Lax");
    // http in tests: a Secure cookie would never be stored by the browser.
    expect(cookie).not.toContain("Secure");

    const planted = cookie?.slice(`${STATE_COOKIE}=`.length).split(";")[0];
    expect(location.searchParams.get("state")).toBe(planted);
  });

  it("503s when the OAuth client is not configured", async () => {
    const t = buildTestApp({ env: { GOOGLE_CLIENT_ID: undefined } });
    const res = await t.request("/api/auth/google", { auth: false });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
  });
});

describe("GET /api/auth/callback", () => {
  it("exchanges the code, creates the user and opens a session", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t);

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");

    const exchange = h.calls[0];
    expect(exchange?.url).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(exchange?.body ?? [])).toEqual({
      code: "abc",
      client_id: CLIENT_ID,
      client_secret: "test-client-secret",
      redirect_uri: "http://test.local/api/auth/callback",
      grant_type: "authorization_code",
    });

    const cookie = setCookieNamed(res, SESSION_COOKIE);
    const sid = cookie?.slice(`${SESSION_COOKIE}=`.length).split(";")[0] ?? "";
    expect(sid).toMatch(/^[0-9a-f]{64}$/);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");

    const rows = await h.t.deps.db
      .select()
      .from(users)
      .where(eq(users.googleSub, "google-sub-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "person@example.com",
      name: "Ana Müller",
      picture: "https://example.com/ana.png",
    });

    const sessionRows = await h.t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sid));
    expect(sessionRows[0]?.expiresAt).toBe(NOW + SESSION_TTL_MS);

    const me = await h.t.request("/api/auth/me", {
      auth: false,
      headers: { cookie: `${SESSION_COOKIE}=${sid}` },
    });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: "person@example.com" });
  });

  it("400s when the state does not match the cookie", async () => {
    // Same length as STATE on purpose, so the byte-by-byte comparison is what
    // rejects it rather than the length early-return.
    expect("fedcba9876543210").toHaveLength(STATE.length);
    const h = buildOAuthApp();
    const res = await callback(h.t, {
      query: "?code=abc&state=fedcba9876543210",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
    expect(h.calls).toHaveLength(0);
  });

  it("400s a state of a different length", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t, { query: "?code=abc&state=short" });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("400s when the state cookie is missing", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t, { cookie: null });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("burns the state cookie whatever the outcome", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t, { query: "?code=abc&state=someone-else" });
    const burnt = setCookieNamed(res, STATE_COOKIE);
    expect(burnt).toContain("Max-Age=0");
  });

  it("400s when Google reports an error instead of a code", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t, {
      query: `?error=access_denied&state=${STATE}`,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
    expect(h.calls).toHaveLength(0);
  });

  it("400s when no authorization code came back", async () => {
    const h = buildOAuthApp();
    const res = await callback(h.t, { query: `?state=${STATE}` });
    expect(res.status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("403s an unverified Google account and creates nothing", async () => {
    const h = buildOAuthApp();
    h.setClaims(googleClaims({ email_verified: false }));
    const res = await callback(h.t);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
    const rows = await h.t.deps.db
      .select()
      .from(users)
      .where(eq(users.googleSub, "google-sub-1"));
    expect(rows).toHaveLength(0);
  });

  it("502s when Google rejects the code exchange", async () => {
    const h = buildOAuthApp();
    h.setResponse(() => new Response("nope", { status: 500 }));
    const res = await callback(h.t);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("auth_failed");
  });

  it("502s when the token response carries no id_token", async () => {
    const h = buildOAuthApp();
    h.setResponse(() => Response.json({ access_token: "a" }));
    const res = await callback(h.t);
    expect(res.status).toBe(502);
  });

  it("502s a malformed id_token", async () => {
    const h = buildOAuthApp();
    h.setResponse(() => Response.json({ id_token: "not.a.jwt" }));
    const res = await callback(h.t);
    expect(res.status).toBe(502);
  });
});

describe("validateGoogleClaims", () => {
  const opts = { clientId: CLIENT_ID, nowMs: NOW };

  it("accepts both issuer spellings Google uses", () => {
    for (const iss of ["https://accounts.google.com", "accounts.google.com"]) {
      expect(validateGoogleClaims(googleClaims({ iss }), opts)).toMatchObject({
        sub: "google-sub-1",
        email: "person@example.com",
      });
    }
  });

  it("rejects a foreign issuer", () => {
    expect(() =>
      validateGoogleClaims(googleClaims({ iss: "https://evil.example" }), opts),
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });

  it("rejects a token minted for another OAuth client", () => {
    expect(() =>
      validateGoogleClaims(googleClaims({ aud: "someone-elses-id" }), opts),
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });

  it("rejects an expired token", () => {
    expect(() =>
      validateGoogleClaims(
        googleClaims({ exp: Math.floor(NOW / 1000) - 1 }),
        opts,
      ),
    ).toThrowError(expect.objectContaining({ status: 502 }));
  });

  it("rejects a token with no subject or no email", () => {
    for (const bad of [{ sub: "" }, { email: "" }]) {
      expect(() => validateGoogleClaims(googleClaims(bad), opts)).toThrowError(
        expect.objectContaining({ status: 502 }),
      );
    }
  });

  it("403s an unverified email", () => {
    expect(() =>
      validateGoogleClaims(googleClaims({ email_verified: false }), opts),
    ).toThrowError(expect.objectContaining({ status: 403 }));
  });

  it("normalises absent name and picture to null", () => {
    const identity = validateGoogleClaims(
      googleClaims({ name: undefined, picture: undefined }),
      opts,
    );
    expect(identity.name).toBeNull();
    expect(identity.picture).toBeNull();
  });
});

describe("owner claim", () => {
  /** Undo the harness's own claim so the row looks like migration 0012 left it. */
  function unclaimOwner(t: TestApp): void {
    t.sqlite.exec(
      "update users set google_sub = null, email = 'owner@placeholder.invalid' where id = 'owner'",
    );
  }

  it("adopts the placeholder row when the email matches OWNER_EMAIL", async () => {
    const h = buildOAuthApp();
    unclaimOwner(h.t);
    // Upper-cased on purpose: the comparison is case-insensitive.
    h.setClaims(googleClaims({ email: "OWNER@TEST.LOCAL" }));

    const res = await callback(h.t);
    expect(res.status).toBe(302);

    const all = await h.t.deps.db.select().from(users);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: "owner",
      googleSub: "google-sub-1",
      email: "OWNER@TEST.LOCAL",
    });
  });

  it("gives a later account with the same address its own row", async () => {
    const h = buildOAuthApp();
    unclaimOwner(h.t);
    h.setClaims(googleClaims({ email: "owner@test.local" }));
    expect((await callback(h.t)).status).toBe(302);

    // The claim already happened, so a different subject cannot take the row.
    h.setClaims(
      googleClaims({ sub: "google-sub-2", email: "owner@test.local" }),
    );
    expect((await callback(h.t)).status).toBe(302);

    const all = await h.t.deps.db.select().from(users);
    expect(all).toHaveLength(2);
    expect(all.map((row) => row.googleSub).sort()).toEqual([
      "google-sub-1",
      "google-sub-2",
    ]);
    const fresh = all.find((row) => row.googleSub === "google-sub-2");
    expect(fresh?.id).not.toBe("owner");
  });

  it("refreshes the profile when the same subject signs in again", async () => {
    const h = buildOAuthApp();
    h.setClaims(googleClaims({ name: "First Name" }));
    expect((await callback(h.t)).status).toBe(302);
    h.setClaims(googleClaims({ name: "Second Name" }));
    expect((await callback(h.t)).status).toBe(302);

    const rows = await h.t.deps.db
      .select()
      .from(users)
      .where(eq(users.googleSub, "google-sub-1"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("Second Name");

    const userId = rows[0]?.id ?? "";
    const openSessions = await h.t.deps.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, userId));
    // Signing in twice opens two sessions; neither invalidates the other.
    expect(openSessions).toHaveLength(2);
  });
});
