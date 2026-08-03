import type { MiddlewareHandler } from "hono";
import { HttpError } from "./http-error.js";

const HEALTH_PATH = "/api/health";

function timingSafeEqual(a: string, b: string): boolean {
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

export function createBearerAuth<E extends { Bindings: { APP_TOKEN: string } }>(
  opts: { exempt?: readonly string[] } = {},
): MiddlewareHandler<E> {
  const exempt = new Set(opts.exempt ?? [HEALTH_PATH]);
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (exempt.has(path)) return next();
    if (!path.startsWith("/api/")) return next();

    const expected = c.env.APP_TOKEN;
    if (!expected) {
      throw new HttpError(401, "unauthorized", "APP_TOKEN is not configured.");
    }

    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      throw new HttpError(401, "unauthorized", "Missing bearer token.");
    }
    const provided = header.slice(7).trim();
    if (!timingSafeEqual(provided, expected)) {
      throw new HttpError(401, "unauthorized", "Invalid bearer token.");
    }
    return next();
  };
}
