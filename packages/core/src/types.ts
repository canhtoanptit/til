export interface Digest {
  title: string;
  summary: string;
  takeaway: string;
  question: string;
  tags: string[];
}

export interface LLMSettings {
  provider: "openai" | "anthropic" | "groq";
  model: string;
  apiKey: string;
  cfAccountId: string;
  cfGatewayId: string;
  cfAigToken?: string;
}

export interface LLMClient {
  digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}

export interface Extractor {
  toMarkdown(
    html: string,
    url: string,
  ): Promise<{ markdown: string; title?: string }>;
}
