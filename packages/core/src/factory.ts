import { AISDKClient } from "./ai-sdk-client.js";
import { DirectLLMClient } from "./direct-client.js";
import type { LLMClient, LLMSettings } from "./types.js";

export function createLLMClient(
  settings: LLMSettings,
  opts?: { impl?: "ai-sdk" | "direct"; fetchImpl?: typeof fetch },
): LLMClient {
  const impl = opts?.impl ?? "ai-sdk";
  if (impl === "direct") {
    return new DirectLLMClient(settings, opts?.fetchImpl);
  }
  return new AISDKClient(settings, opts?.fetchImpl);
}
