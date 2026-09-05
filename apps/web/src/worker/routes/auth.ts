import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppBindings, AppContextEnv, SessionUser } from "../deps.js";
import {
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  buildGoogleAuthUrl,
  decodeIdTokenClaims,
  exchangeCodeForIdToken,
  validateGoogleClaims,
} from "../google-oauth.js";
import { HttpError } from "../http-error.js";
import { devIdentity, upsertGoogleUser } from "../identity.js";
import { devLoginSchema } from "../schemas.js";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  deleteSession,
  isSecureRequest,
  randomHex,
  sessionUserFrom,
  setSessionCookie,
  timingSafeEqual,
} from "../session.js";

interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

/**
 * Fails closed: with no OAuth client configured there is no safe degraded mode
 * to fall back to, and a 503 naming the two secrets is what an operator needs.
 */
function requireGoogleConfig(env: AppBindings): GoogleConfig {
  const clientId = env.GOOGLE_CLIENT_ID ?? "";
  const clientSecret = env.GOOGLE_CLIENT_SECRET ?? "";
  if (clientId.length === 0 || clientSecret.length === 0) {
    throw new HttpError(
      503,
      "auth_failed",
      "Google sign-in is not configured — set the GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets.",
    );
  }
  return { clientId, clientSecret };
}

/**
 * Derived from the request, never configured: one worker can be reached on
 * localhost, workers.dev and a custom domain, and each needs its own redirect
 * URI registered with Google — but none of them needs a second env var here.
 */
function callbackUri(url: string): string {
  return `${new URL(url).origin}/api/auth/callback`;
}

function toMeBody(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    picture: user.picture,
  };
}

export function createAuthRouter() {
  const router = new Hono<AppContextEnv>();

  router.get("/google", (c) => {
    const { clientId } = requireGoogleConfig(c.env);
    const state = randomHex(16);
    setCookie(c, STATE_COOKIE, state, {
      // Narrower than the session cookie on purpose: the state secret is only
      // ever read back by /api/auth/callback.
      path: "/api/auth",
      httpOnly: true,
      sameSite: "Lax",
      maxAge: STATE_TTL_SECONDS,
      secure: isSecureRequest(c),
    });
    return c.redirect(
      buildGoogleAuthUrl({
        clientId,
        redirectUri: callbackUri(c.req.url),
        state,
      }),
      302,
    );
  });

  router.get("/callback", async (c) => {
    const { clientId, clientSecret } = requireGoogleConfig(c.env);
    const deps = c.get("deps");

    // Burned unconditionally, before any other decision: a state value that has
    // been presented once must never be replayable, whatever the outcome.
    const expectedState = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/api/auth" });

    const error = c.req.query("error");
    if (error) {
      throw new HttpError(
        400,
        "auth_failed",
        `Google sign-in was not completed (${error}).`,
      );
    }

    const providedState = c.req.query("state");
    if (
      !expectedState ||
      !providedState ||
      !timingSafeEqual(providedState, expectedState)
    ) {
      throw new HttpError(
        400,
        "auth_failed",
        "Sign-in state did not match — start again from the sign-in page.",
      );
    }

    const code = c.req.query("code");
    if (!code) {
      throw new HttpError(
        400,
        "auth_failed",
        "Google sign-in returned no authorization code.",
      );
    }

    const idToken = await exchangeCodeForIdToken(deps.fetchImpl, {
      code,
      clientId,
      clientSecret,
      redirectUri: callbackUri(c.req.url),
    });
    const identity = validateGoogleClaims(decodeIdTokenClaims(idToken), {
      clientId,
      nowMs: deps.now(),
    });

    const user = await upsertGoogleUser(
      deps.db,
      deps.now(),
      identity,
      c.env.OWNER_EMAIL,
    );
    setSessionCookie(c, await createSession(deps.db, deps.now(), user.id));
    // Back to the SPA, which asks /api/auth/me who just arrived.
    return c.redirect("/", 302);
  });

  router.post("/logout", async (c) => {
    const sid = getCookie(c, SESSION_COOKIE);
    if (sid) await deleteSession(c.get("deps").db, sid);
    clearSessionCookie(c);
    // 204 whatever the cookie was: "you are signed out" is the only honest
    // answer to a logout, and an error here would strand a stale cookie.
    return c.body(null, 204);
  });

  router.get("/me", async (c) => {
    const user = await sessionUserFrom(c);
    if (!user) throw new HttpError(401, "unauthorized", "Not signed in.");
    return c.json(toMeBody(user));
  });

  router.post("/dev-login", async (c) => {
    // The gate runs before anything else, including body validation, so this
    // endpoint is indistinguishable from a route that does not exist anywhere
    // except a local stack.
    if (c.env.TIL_STACK !== "local") {
      throw new HttpError(404, "not_found", "Not found.");
    }
    const deps = c.get("deps");
    // Parsed by hand rather than with zValidator so the 404 above wins: a
    // validator registered as middleware would answer 422 on a deployed worker
    // and leak the endpoint's existence.
    const body = devLoginSchema.parse(await c.req.json().catch(() => ({})));
    const user = await upsertGoogleUser(
      deps.db,
      deps.now(),
      devIdentity(body.email),
      c.env.OWNER_EMAIL,
    );
    setSessionCookie(c, await createSession(deps.db, deps.now(), user.id));
    return c.json(toMeBody(user));
  });

  return router;
}
