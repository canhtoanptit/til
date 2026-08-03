import { describe, expect, it } from "vitest";
import { buildTestApp } from "./test-harness.js";

describe("settings routes", () => {
  it("GET returns 404 when unset", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings");
    expect(res.status).toBe(404);
  });

  it("PUT partial body → 422", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", model: "x" }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("PUT full body then GET returns masked key", async () => {
    const t = buildTestApp();
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-live-abcdef1234",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(put.status).toBe(200);
    const get = await t.request("/api/settings");
    const body = (await get.json()) as {
      apiKeyMasked: string;
      hasAigToken: boolean;
      provider: string;
    };
    expect(body.apiKeyMasked).toBe("••••1234");
    expect(body.hasAigToken).toBe(false);
    expect(body.provider).toBe("openai");
  });

  it("PUT upsert overwrites the row", async () => {
    const t = buildTestApp();
    await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-live-1111",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        model: "claude-3-5",
        apiKey: "sk-ant-9999",
        cfAccountId: "acc2",
        cfGatewayId: "gw2",
        cfAigToken: "aig-secret",
      }),
    });
    const res = await t.request("/api/settings");
    const body = (await res.json()) as {
      provider: string;
      model: string;
      apiKeyMasked: string;
      hasAigToken: boolean;
    };
    expect(body.provider).toBe("anthropic");
    expect(body.model).toBe("claude-3-5");
    expect(body.apiKeyMasked).toBe("••••9999");
    expect(body.hasAigToken).toBe(true);
  });

  it("POST /test 404 when unset", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings/test", { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("POST /test calls ping and returns result", async () => {
    let pinged = false;
    const t = buildTestApp({
      llmFactory: () => ({
        digest: async () => {
          throw new Error("no");
        },
        ping: async () => {
          pinged = true;
          return { ok: false, detail: "nope" };
        },
      }),
    });
    await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-live-1234",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    const res = await t.request("/api/settings/test", { method: "POST" });
    expect(res.status).toBe(200);
    expect(pinged).toBe(true);
    const body = (await res.json()) as { ok: boolean; detail?: string };
    expect(body.ok).toBe(false);
    expect(body.detail).toBe("nope");
  });
});
