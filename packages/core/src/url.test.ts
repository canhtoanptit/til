import { describe, expect, it } from "vitest";
import { UnsafeUrlError } from "./errors.js";
import { assertSafeUrl, gatewayBaseURL, normalizeUrl } from "./url.js";
import type { LLMSettings } from "./types.js";

const baseSettings: LLMSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  cfAccountId: "acct123",
  cfGatewayId: "gw456",
};

describe("gatewayBaseURL", () => {
  it("builds URL for openai", () => {
    expect(gatewayBaseURL(baseSettings)).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/openai",
    );
  });
  it("builds URL for anthropic", () => {
    expect(gatewayBaseURL({ ...baseSettings, provider: "anthropic" })).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/gw456/anthropic",
    );
  });
  it("has no trailing slash", () => {
    expect(gatewayBaseURL(baseSettings).endsWith("/")).toBe(false);
  });
});

describe("normalizeUrl", () => {
  it("strips utm_* params", () => {
    const r = normalizeUrl(
      "https://example.com/post?utm_source=x&utm_medium=y&utm_campaign=z&keep=1",
    );
    expect(r.url).toBe("https://example.com/post?keep=1");
    expect(r.sourceDomain).toBe("example.com");
  });

  it("strips fbclid and gclid", () => {
    const r = normalizeUrl(
      "https://example.com/post?fbclid=abc&gclid=xyz&msclkid=m",
    );
    expect(r.url).toBe("https://example.com/post");
  });

  it("strips mixed tracker + normal params, preserving order of survivors", () => {
    const r = normalizeUrl(
      "https://example.com/post?a=1&utm_source=x&b=2&fbclid=abc&c=3",
    );
    const surviving = new URL(r.url).searchParams;
    expect([...surviving.keys()]).toEqual(["a", "b", "c"]);
  });

  it("drops fragments", () => {
    const r = normalizeUrl("https://example.com/post#section-2");
    expect(r.url).toBe("https://example.com/post");
    expect(r.canonicalUrl).toBe("https://example.com/post");
  });

  it("lowercases host", () => {
    const r = normalizeUrl("https://EXAMPLE.com/PATH");
    expect(r.url).toBe("https://example.com/PATH");
    expect(r.sourceDomain).toBe("example.com");
  });

  it("strips leading www. from sourceDomain but not from url", () => {
    const r = normalizeUrl("https://www.example.com/foo");
    expect(r.sourceDomain).toBe("example.com");
    expect(r.url).toBe("https://www.example.com/foo");
  });

  it("canonicalUrl trims trailing slash from root", () => {
    const r = normalizeUrl("https://example.com/");
    expect(r.canonicalUrl).toBe("https://example.com");
  });

  it("is case-insensitive on tracker param keys", () => {
    const r = normalizeUrl("https://example.com/?UTM_SOURCE=x&FBCLID=y");
    expect(r.url).toBe("https://example.com/");
  });
});

describe("assertSafeUrl", () => {
  it("accepts a normal https URL", () => {
    const u = assertSafeUrl("https://example.com/foo");
    expect(u.hostname).toBe("example.com");
  });

  it("accepts a normal http URL", () => {
    const u = assertSafeUrl("http://example.com/foo");
    expect(u.hostname).toBe("example.com");
  });

  it("rejects ftp scheme", () => {
    expect(() => assertSafeUrl("ftp://example.com/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects file scheme", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(UnsafeUrlError);
  });

  it("rejects javascript scheme", () => {
    expect(() => assertSafeUrl("javascript:alert(1)")).toThrow(UnsafeUrlError);
  });

  it("rejects localhost", () => {
    expect(() => assertSafeUrl("http://localhost:8080/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects *.localhost", () => {
    expect(() => assertSafeUrl("http://api.localhost/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects loopback 127.0.0.1", () => {
    expect(() => assertSafeUrl("http://127.0.0.1/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects loopback 127.1.2.3", () => {
    expect(() => assertSafeUrl("http://127.1.2.3/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects private 10.0.0.1", () => {
    expect(() => assertSafeUrl("http://10.0.0.1/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects private 192.168.0.1", () => {
    expect(() => assertSafeUrl("http://192.168.0.1/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects private 172.16.0.1", () => {
    expect(() => assertSafeUrl("http://172.16.0.1/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects private 172.31.255.254", () => {
    expect(() => assertSafeUrl("http://172.31.255.254/foo")).toThrow(
      UnsafeUrlError,
    );
  });

  it("accepts 172.15.0.1 (outside private range)", () => {
    expect(assertSafeUrl("http://172.15.0.1/foo").hostname).toBe("172.15.0.1");
  });

  it("accepts 172.32.0.1 (outside private range)", () => {
    expect(assertSafeUrl("http://172.32.0.1/foo").hostname).toBe("172.32.0.1");
  });

  it("rejects link-local 169.254.169.254 (metadata IP)", () => {
    expect(() => assertSafeUrl("http://169.254.169.254/latest/meta-data")).toThrow(
      UnsafeUrlError,
    );
  });

  it("rejects IPv6 loopback [::1]", () => {
    expect(() => assertSafeUrl("http://[::1]/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects IPv6 link-local fe80::", () => {
    expect(() => assertSafeUrl("http://[fe80::1]/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects IPv6 ULA fc00::", () => {
    expect(() => assertSafeUrl("http://[fc00::1]/foo")).toThrow(UnsafeUrlError);
  });

  it("rejects garbage input", () => {
    expect(() => assertSafeUrl("not a url")).toThrow(UnsafeUrlError);
  });
});
