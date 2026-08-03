import type { Settings } from "@til/db";
import type { LLMSettings } from "@til/core";

type Provider = LLMSettings["provider"];

export interface SettingsDTO {
  provider: Provider;
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

function narrowProvider(raw: string): Provider {
  if (raw === "anthropic" || raw === "groq") return raw;
  return "openai";
}

export function toSettingsDTO(row: Settings): SettingsDTO {
  return {
    provider: narrowProvider(row.provider),
    model: row.model,
    apiKeyMasked: maskApiKey(row.apiKey),
    cfAccountId: row.cfAccountId,
    cfGatewayId: row.cfGatewayId,
    hasAigToken: !!row.cfAigToken,
  };
}

export function toLLMSettings(row: Settings): LLMSettings {
  return {
    provider: narrowProvider(row.provider),
    model: row.model,
    apiKey: row.apiKey,
    cfAccountId: row.cfAccountId,
    cfGatewayId: row.cfGatewayId,
    cfAigToken: row.cfAigToken ?? undefined,
  };
}
