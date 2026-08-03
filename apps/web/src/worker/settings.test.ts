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

  it("PUT with provider 'groq' → 200 and GET returns groq", async () => {
    const t = buildTestApp();
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        apiKey: "gsk_live_abcdef1234",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(put.status).toBe(200);
    const get = await t.request("/api/settings");
    const body = (await get.json()) as {
      provider: string;
      model: string;
      apiKeyMasked: string;
    };
    expect(body.provider).toBe("groq");
    expect(body.model).toBe("llama-3.3-70b-versatile");
    expect(body.apiKeyMasked).toBe("••••1234");
  });

  it("PUT with invalid provider → 422", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "gemini",
        model: "gemini-1.5",
        apiKey: "k",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
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

  it("PUT omitting apiKey with unchanged routing → 200 and keeps the stored key", async () => {
    const seen: string[] = [];
    const t = buildTestApp({
      llmFactory: (s) => {
        seen.push(s.apiKey);
        return {
          digest: async () => {
            throw new Error("no");
          },
          ping: async () => ({ ok: true }),
        };
      },
    });
    await t.request("/api/settings", {
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
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as { model: string; apiKeyMasked: string };
    expect(body.model).toBe("gpt-4o");
    expect(body.apiKeyMasked).toBe("••••1234");

    const test = await t.request("/api/settings/test", { method: "POST" });
    expect(test.status).toBe(200);
    expect(seen).toEqual(["sk-live-abcdef1234"]);
  });

  it("PUT omitting apiKey while changing cfGatewayId → 422", async () => {
    const t = buildTestApp();
    await t.request("/api/settings", {
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
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        cfAccountId: "acc",
        cfGatewayId: "gw-other",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("validation_error");
    expect(body.error.message).toContain("apiKey");
    const get = await t.request("/api/settings");
    const dto = (await get.json()) as {
      cfGatewayId: string;
      apiKeyMasked: string;
    };
    expect(dto.cfGatewayId).toBe("gw");
    expect(dto.apiKeyMasked).toBe("••••1234");
  });

  it("PUT omitting apiKey while changing provider → 422", async () => {
    const t = buildTestApp();
    await t.request("/api/settings", {
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
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
    const get = await t.request("/api/settings");
    const dto = (await get.json()) as { provider: string };
    expect(dto.provider).toBe("openai");
  });

  it("PUT omitting apiKey with no stored row → 422", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
    const get = await t.request("/api/settings");
    expect(get.status).toBe(404);
  });

  it("PUT adding cfAigToken while omitting apiKey → 200, token set, key unchanged", async () => {
    const seen: string[] = [];
    const t = buildTestApp({
      llmFactory: (s) => {
        seen.push(`${s.apiKey}|${s.cfAigToken ?? ""}`);
        return {
          digest: async () => {
            throw new Error("no");
          },
          ping: async () => ({ ok: true }),
        };
      },
    });
    await t.request("/api/settings", {
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
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        cfAccountId: "acc",
        cfGatewayId: "gw",
        cfAigToken: "aig-secret",
      }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      hasAigToken: boolean;
      apiKeyMasked: string;
    };
    expect(body.hasAigToken).toBe(true);
    expect(body.apiKeyMasked).toBe("••••1234");

    await t.request("/api/settings/test", { method: "POST" });
    expect(seen).toEqual(["sk-live-abcdef1234|aig-secret"]);
  });

  it("PUT omitting cfAigToken keeps the stored token", async () => {
    const t = buildTestApp();
    await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-live-abcdef1234",
        cfAccountId: "acc",
        cfGatewayId: "gw",
        cfAigToken: "aig-secret",
      }),
    });
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      hasAigToken: boolean;
      model: string;
    };
    expect(body.hasAigToken).toBe(true);
    expect(body.model).toBe("gpt-4o");
  });

  it("PUT with cfAigToken '' clears the token and keeps the key", async () => {
    const t = buildTestApp();
    await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "sk-live-abcdef1234",
        cfAccountId: "acc",
        cfGatewayId: "gw",
        cfAigToken: "aig-secret",
      }),
    });
    const put = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        cfAccountId: "acc",
        cfGatewayId: "gw",
        cfAigToken: "",
      }),
    });
    expect(put.status).toBe(200);
    const body = (await put.json()) as {
      hasAigToken: boolean;
      apiKeyMasked: string;
    };
    expect(body.hasAigToken).toBe(false);
    expect(body.apiKeyMasked).toBe("••••1234");
  });

  it("PUT with an empty apiKey string → 422", async () => {
    const t = buildTestApp();
    const res = await t.request("/api/settings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai",
        model: "gpt-4o-mini",
        apiKey: "",
        cfAccountId: "acc",
        cfGatewayId: "gw",
      }),
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
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
