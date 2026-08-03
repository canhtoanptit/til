import { describe, expect, it } from "vitest";
import { AISDKClient } from "./ai-sdk-client.js";
import { DirectLLMClient } from "./direct-client.js";
import { createLLMClient } from "./factory.js";
import type { LLMSettings } from "./types.js";

const settings: LLMSettings = {
  provider: "openai",
  model: "gpt-4o-mini",
  apiKey: "sk-test",
  cfAccountId: "acct",
  cfGatewayId: "gw",
};

const noopFetch = (async () =>
  new Response("{}")) as unknown as typeof fetch;

describe("createLLMClient", () => {
  it("returns an AISDKClient by default", () => {
    const client = createLLMClient(settings, { fetchImpl: noopFetch });
    expect(client).toBeInstanceOf(AISDKClient);
  });

  it("returns AISDKClient when impl is ai-sdk", () => {
    const client = createLLMClient(settings, {
      impl: "ai-sdk",
      fetchImpl: noopFetch,
    });
    expect(client).toBeInstanceOf(AISDKClient);
  });

  it("returns a DirectLLMClient when impl is direct", () => {
    const client = createLLMClient(settings, {
      impl: "direct",
      fetchImpl: noopFetch,
    });
    expect(client).toBeInstanceOf(DirectLLMClient);
  });
});
