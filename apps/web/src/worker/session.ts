import type { Db } from "@til/db";
import { sessions, users } from "@til/db";
import { eq, lte } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppContextEnv, SessionUser } from "./deps.js";
import { HttpError } from "./http-error.js";

/**
 * Opaque server-side sessions (ADR-0013). The cookie carries nothing but a
 * 256-bit random id: no claims, no signature, nothing to forge offline — the
 * only way to hold a valid session is to have a row in D1 that says so, and
 * deleting that row logs the browser out everywhere at once.
 */
export const SESSION_COOKIE = "til_session";

/** Fixed, not sliding: a session dies 30 days after it was created, full stop. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const EXEMPT_PATHS = new Set([
  "/api/health",
  "/api/auth/google",
  "/api/auth/callback",
  "/api/auth/dev-login",
  // /me and /logout answer for themselves: both are meaningful *without* a
  // valid session (401-shaped "who am I" and an idempotent 204), so a blanket
  // 401 here would make signing out of an expired session impossible.
  "/api/auth/me",
  "/api/auth/logout",
]);

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Moved verbatim from the retired bearer middleware. Still needed: the OAuth
 * state check compares two secrets that arrived over different channels, and a
 * length-leaking early return there is a (small) oracle.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

export async function createSession(
  db: Db,
  now: number,
  userId: string,
): Promise<string> {
  const id = randomHex(32);
  await db.insert(sessions).values({
    id,
    userId,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
  });
  return id;
}

export async function deleteSession(db: Db, id: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, id));
}

/**
 * `Secure` is derived, never configured: on https the cookie must not be
 * downgradable to http, and on plain http (`vite dev`) a Secure cookie would
 * simply never be stored, silently breaking local sign-in.
 */
export function isSecureRequest(c: Context<AppContextEnv>): boolean {
  return new URL(c.req.url).protocol === "https:";
}

export function setSessionCookie(c: Context<AppContextEnv>, id: string): void {
  setCookie(c, SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    // Lax, not Strict: the Google callback is a cross-site *navigation* back
    // into this origin, and Strict would withhold the cookie we just set on the
    // very next request.
    sameSite: "Lax",
    maxAge: SESSION_TTL_MS / 1000,
    secure: isSecureRequest(c),
  });
}

export function clearSessionCookie(c: Context<AppContextEnv>): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/**
 * Resolves the caller from the session cookie, or null. One joined read —
 * the session row proves the cookie, the user row supplies the identity the
 * routes and the client header need.
 */
export async function sessionUserFrom(
  c: Context<AppContextEnv>,
): Promise<SessionUser | null> {
  const sid = getCookie(c, SESSION_COOKIE);
  if (!sid) return null;

  const deps = c.get("deps");
  const now = deps.now();
  const rows = await deps.db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      picture: users.picture,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sid))
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt <= now) {
    // Opportunistic sweep: there is no cron for sessions, so the cheapest place
    // to collect dead rows is the request that just tripped over one.
    await deps.db.delete(sessions).where(lte(sessions.expiresAt, now));
    return null;
  }
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    picture: row.picture,
  };
}

/**
 * The single gate on `/api/*`. Replaces the shared-token bearer middleware
 * (ADR-0013): every request now names a *person*, which is what per-user
 * tenancy needs.
 *
 * No WebSocket special case, and therefore no chat tickets: the upgrade to
 * `/api/chat/:id` is same-origin, so the browser puts `til_session` on it like
 * any other request.
 */
export function createSessionAuth(): MiddlewareHandler<AppContextEnv> {
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (EXEMPT_PATHS.has(url.pathname)) return next();
    // Everything outside /api/ is the SPA's own asset space, served by ASSETS.
    if (!url.pathname.startsWith("/api/")) return next();

    const user = await sessionUserFrom(c);
    if (!user) {
      throw new HttpError(401, "unauthorized", "Not signed in.");
    }
    c.set("user", user);
    return next();
  };
}
