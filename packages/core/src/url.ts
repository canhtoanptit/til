import { UnsafeUrlError } from "./errors.js";
import type { LLMSettings } from "./types.js";

export function gatewayBaseURL(settings: LLMSettings): string {
  const { cfAccountId, cfGatewayId, provider } = settings;
  return `https://gateway.ai.cloudflare.com/v1/${cfAccountId}/${cfGatewayId}/${provider}`;
}

const TRACKER_PARAMS = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "yclid",
  "_ga",
  "_gl",
]);

function isTrackerParam(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("utm_")) return true;
  return TRACKER_PARAMS.has(lower);
}

export function normalizeUrl(raw: string): {
  url: string;
  canonicalUrl: string;
  sourceDomain: string;
} {
  const parsed = new URL(raw);
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();

  const params = parsed.searchParams;
  const removeKeys: string[] = [];
  for (const key of params.keys()) {
    if (isTrackerParam(key)) removeKeys.push(key);
  }
  for (const key of removeKeys) params.delete(key);

  const cleaned = parsed.toString();
  const canonical = cleaned.endsWith("/") ? cleaned.slice(0, -1) : cleaned;
  const host = parsed.hostname.replace(/^www\./, "");

  return {
    url: cleaned,
    canonicalUrl: canonical,
    sourceDomain: host,
  };
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    out.push(n);
  }
  return out;
}

function isPrivateIPv4(host: string): boolean {
  const oct = parseIPv4(host);
  if (!oct) return false;
  const [a, b] = oct;
  if (a === undefined || b === undefined) return false;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 0) return true;
  return false;
}

function stripIPv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
}

function isIPv6Literal(host: string): boolean {
  return host.includes(":");
}

function isPrivateIPv6(host: string): boolean {
  const bare = stripIPv6Brackets(host).toLowerCase();
  if (!isIPv6Literal(bare)) return false;
  if (bare === "::1") return true;
  if (bare === "::" || bare === "0:0:0:0:0:0:0:0") return true;
  if (bare.startsWith("fe8") || bare.startsWith("fe9")) return true;
  if (bare.startsWith("fea") || bare.startsWith("feb")) return true;
  if (bare.startsWith("fc") || bare.startsWith("fd")) return true;
  return false;
}

export function assertSafeUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError(`Invalid URL: ${raw}`);
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "http:" && protocol !== "https:") {
    throw new UnsafeUrlError(`Unsupported scheme: ${protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "" || hostname === "localhost") {
    throw new UnsafeUrlError(`Blocked host: ${hostname || "(empty)"}`);
  }
  if (hostname.endsWith(".localhost")) {
    throw new UnsafeUrlError(`Blocked host: ${hostname}`);
  }
  if (isPrivateIPv4(hostname)) {
    throw new UnsafeUrlError(`Blocked IPv4 host: ${hostname}`);
  }
  if (isPrivateIPv6(parsed.hostname)) {
    throw new UnsafeUrlError(`Blocked IPv6 host: ${parsed.hostname}`);
  }

  return parsed;
}
