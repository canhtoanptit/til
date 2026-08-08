import type { Context, MiddlewareHandler } from "hono";
import { HttpError } from "./http-error.js";

const HEALTH_PATH = "/api/health";

/**
 * A browser cannot set request headers on a WebSocket handshake, so the chat
 * transport cannot carry `Authorization`. The two mechanisms the Agents SDK
 * client offers are `query` and `protocols`; `protocols` is unusable because the
 * dev pipeline (vite plugin's `ws` server) never selects a subprotocol back, and
 * a client that offered one then fails the handshake. So the handshake carries a
 * short-lived signed ticket in the query string instead of APP_TOKEN itself: a
 * ticket in an access log expires within a minute and grants nothing else.
 */
export const CHAT_TICKET_PARAM = "ticket";
export const CHAT_TICKET_TTL_MS = 60_000;
export const CHAT_TICKET_PATH_PREFIX = "/api/chat/";

const TICKET_CONTEXT = "til-chat-ticket:";

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

function base64url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(appToken: string, expiresAt: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${TICKET_CONTEXT}${expiresAt}`),
  );
  return base64url(mac);
}

export interface ChatTicket {
  ticket: string;
  expiresAt: number;
}

export async function mintChatTicket(
  appToken: string,
  now: number,
): Promise<ChatTicket> {
  const expiresAt = now + CHAT_TICKET_TTL_MS;
  return { ticket: `${expiresAt}.${await sign(appToken, expiresAt)}`, expiresAt };
}

/**
 * Deliberately reusable until it expires rather than single-use: partysocket
 * reconnects on its own, and a burned ticket would turn one dropped frame into a
 * dead conversation.
 */
export async function verifyChatTicket(
  appToken: string,
  ticket: string,
  now: number,
): Promise<boolean> {
  const dot = ticket.indexOf(".");
  if (dot <= 0) return false;
  const expiresAt = Number(ticket.slice(0, dot));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  if (expiresAt > now + CHAT_TICKET_TTL_MS) return false;
  return timingSafeEqual(ticket.slice(dot + 1), await sign(appToken, expiresAt));
}

export function bearerToken(req: {
  header(name: string): string | undefined;
}): string | null {
  const auth = req.header("authorization") ?? req.header("Authorization");
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) return null;
  return auth.slice(7).trim();
}

export function isWebSocketUpgrade(req: {
  header(name: string): string | undefined;
}): boolean {
  return (req.header("upgrade") ?? "").toLowerCase() === "websocket";
}

/** One clock for minting and verifying, so a pinned test clock stays coherent. */
export function authClock(c: Context): number {
  const deps = c.get("deps") as { now?: () => number } | undefined;
  return deps?.now?.() ?? Date.now();
}

export function createBearerAuth<
  E extends { Bindings: { APP_TOKEN: string } },
>(opts: { exempt?: readonly string[] } = {}): MiddlewareHandler<E> {
  const exempt = new Set(opts.exempt ?? [HEALTH_PATH]);
  return async (c, next) => {
    const url = new URL(c.req.url);
    if (exempt.has(url.pathname)) return next();
    if (!url.pathname.startsWith("/api/")) return next();

    const expected = c.env.APP_TOKEN;
    if (!expected) {
      throw new HttpError(401, "unauthorized", "APP_TOKEN is not configured.");
    }

    const req = (c as Context).req;
    const provided = bearerToken(req);
    if (provided !== null) {
      if (!timingSafeEqual(provided, expected)) {
        throw new HttpError(401, "unauthorized", "Invalid bearer token.");
      }
      return next();
    }

    // Tickets are accepted only on the chat WebSocket handshake — never for the
    // REST API, so a URL is never a credential for anything else.
    if (url.pathname.startsWith(CHAT_TICKET_PATH_PREFIX) && isWebSocketUpgrade(req)) {
      const ticket = url.searchParams.get(CHAT_TICKET_PARAM);
      if (
        ticket &&
        (await verifyChatTicket(expected, ticket, authClock(c as Context)))
      ) {
        return next();
      }
      throw new HttpError(
        401,
        "unauthorized",
        "Missing or expired chat ticket.",
      );
    }

    throw new HttpError(401, "unauthorized", "Missing bearer token.");
  };
}
