import type { Settings } from "@til/db";
import type { LLMSettings } from "@til/core";

export interface SettingsDTO {
  provider: "openai" | "anthropic";
  model: string;
  apiKeyMasked: string;
  cfAccountId: string;
  cfGatewayId: string;
  hasAigToken: boolean;
}

export function maskApiKey(key: string): string {
  if (key.length <= 4) return "•".repeat(4);
  return `••••${key.slice(-4)}`;
}

export function toSettingsDTO(row: Settings): SettingsDTO {
  const provider = row.provider === "anthropic" ? "anthropic" : "openai";
  return {
    provider,
    model: row.model,
    apiKeyMasked: maskApiKey(row.apiKey),
    cfAccountId: row.cfAccountId,
    cfGatewayId: row.cfGatewayId,
    hasAigToken: !!row.cfAigToken,
  };
}

export function toLLMSettings(row: Settings): LLMSettings {
  const provider = row.provider === "anthropic" ? "anthropic" : "openai";
  return {
    provider,
    model: row.model,
    apiKey: row.apiKey,
    cfAccountId: row.cfAccountId,
    cfGatewayId: row.cfGatewayId,
    cfAigToken: row.cfAigToken ?? undefined,
  };
}
