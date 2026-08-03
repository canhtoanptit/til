import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-harness.js";

describe("auth middleware", () => {
  it("permits /api/health without a token", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/health", { auth: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rejects protected route without token", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/entries", { auth: false });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects wrong bearer token", async () => {
    const t = buildTestApp({ appToken: "expected" });
    const res = await t.request("/api/entries", {
      auth: false,
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts correct bearer token", async () => {
    const t = buildTestApp({ appToken: "hunter2" });
    const res = await t.request("/api/entries", {
      auth: false,
      headers: { authorization: "Bearer hunter2" },
    });
    expect(res.status).toBe(200);
  });
});
