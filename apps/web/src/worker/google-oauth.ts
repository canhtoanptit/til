import { HttpError } from "./http-error.js";

/**
 * A hand-rolled Google OIDC authorization-code flow (ADR-0013). Every function
 * here is pure or takes its `fetch` as an argument, so the whole exchange is
 * testable without a network and without a dependency.
 */
export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/** Double-submit CSRF state. Scoped to /api/auth so it rides nothing else. */
export const STATE_COOKIE = "til_oauth_state";
export const STATE_TTL_SECONDS = 600;

const ACCEPTED_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  picture: string | null;
}

export function buildGoogleAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  // The minimum that yields an id_token with an address: no Gmail, no Drive,
  // nothing that would need Google's verification review.
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export async function exchangeCodeForIdToken(
  fetchImpl: typeof fetch,
  opts: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  },
): Promise<string> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new HttpError(
      502,
      "auth_failed",
      `Google rejected the authorization code (HTTP ${res.status}).`,
    );
  }
  const payload = (await res.json().catch(() => null)) as {
    id_token?: unknown;
  } | null;
  const idToken = payload?.id_token;
  if (typeof idToken !== "string" || idToken.length === 0) {
    throw new HttpError(
      502,
      "auth_failed",
      "Google's token response carried no id_token.",
    );
  }
  return idToken;
}

/**
 * WHY no JWKS signature verification (ADR-0013): this token did not arrive
 * from the browser. It came back on our own TLS connection to Google's token
 * endpoint, in response to a request carrying our client secret — so the
 * transport already authenticates the issuer, and a signature check would
 * re-prove the same fact against a key set we would have to fetch and cache.
 * The claim checks in `validateGoogleClaims` still run: they guard against a
 * token minted for a *different* client, not against forgery.
 */
export function decodeIdTokenClaims(idToken: string): Record<string, unknown> {
  const parts = idToken.split(".");
  if (parts.length !== 3) {
    throw new HttpError(502, "auth_failed", "Malformed id_token from Google.");
  }
  const encoded = parts[1] ?? "";
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    // Not atob-to-string: display names are routinely non-ASCII, and reading
    // the payload as latin-1 would mangle them before they reach the database.
    const bytes = Uint8Array.from(atob(padded), (ch) => ch.charCodeAt(0));
    const claims: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof claims !== "object" || claims === null) {
      throw new Error("claims are not an object");
    }
    return claims as Record<string, unknown>;
  } catch {
    throw new HttpError(
      502,
      "auth_failed",
      "Could not read the id_token payload from Google.",
    );
  }
}

export function validateGoogleClaims(
  claims: Record<string, unknown>,
  opts: { clientId: string; nowMs: number },
): GoogleIdentity {
  const iss = claims["iss"];
  if (typeof iss !== "string" || !ACCEPTED_ISSUERS.includes(iss)) {
    throw new HttpError(
      502,
      "auth_failed",
      "id_token has an unexpected issuer.",
    );
  }
  // The one check that actually matters for a decode-only flow: a token minted
  // for someone else's OAuth client must never sign anyone in here.
  if (claims["aud"] !== opts.clientId) {
    throw new HttpError(
      502,
      "auth_failed",
      "id_token was issued for a different OAuth client.",
    );
  }
  const exp = claims["exp"];
  if (typeof exp !== "number" || exp * 1000 <= opts.nowMs) {
    throw new HttpError(502, "auth_failed", "id_token has expired.");
  }
  if (claims["email_verified"] !== true) {
    throw new HttpError(
      403,
      "auth_failed",
      "Google account email is not verified.",
    );
  }
  const sub = claims["sub"];
  const email = claims["email"];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new HttpError(502, "auth_failed", "id_token carried no subject.");
  }
  if (typeof email !== "string" || email.length === 0) {
    throw new HttpError(502, "auth_failed", "id_token carried no email.");
  }
  const name = claims["name"];
  const picture = claims["picture"];
  return {
    sub,
    email,
    name: typeof name === "string" && name.length > 0 ? name : null,
    picture: typeof picture === "string" && picture.length > 0 ? picture : null,
  };
}
