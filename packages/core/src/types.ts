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

export interface SynthesisInput {
  canonicalUrl: string;
  title: string;
  sources: string[];
  publishedAt: number;
  score: number;
  snippet?: string;
}

export interface DigestItemDraft {
  canonicalUrl: string;
  title: string;
  why: string;
}

export interface DigestSynthesis {
  title: string;
  intro: string;
  items: DigestItemDraft[];
}

export interface LLMClient {
  digest(
    markdown: string,
    meta: { url: string; title?: string },
  ): Promise<Digest>;
  synthesizeDigest(
    inputs: SynthesisInput[],
    opts: { windowDays: number; maxItems: number },
  ): Promise<DigestSynthesis>;
  ping(): Promise<{ ok: boolean; detail?: string }>;
}

export interface Extractor {
  toMarkdown(
    html: string,
    url: string,
  ): Promise<{ markdown: string; title?: string }>;
}

export interface Candidate {
  url: string;
  title: string;
  sourceName: string;
  publishedAt: number;
  popularity?: number;
  snippet?: string;
}

export interface FetchCandidatesOptions {
  windowDays: number;
  limit: number;
  fetchImpl?: typeof fetch;
}

export interface SourceAdapter {
  readonly name: string;
  fetchCandidates(opts: FetchCandidatesOptions): Promise<Candidate[]>;
}

export type StackMode = "local" | "cloud";

// Implementations MUST return L2-normalized (unit-length) vectors (ADR-0010) so
// that cosine similarity reduces to a dot product and both stacks rank alike.
export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata: {
    domain: string;
    createdAt: number;
    embedModel: string;
  };
}

export interface VectorStore {
  upsert(vectors: VectorRecord[]): Promise<void>;
  query(values: number[], opts: { topK: number }): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

export interface EvidenceCluster {
  canonicalUrl: string;
  title: string;
  candidates: Candidate[];
  sources: string[];
  publishedAt: number;
}

export interface ScoredCluster extends EvidenceCluster {
  score: number;
}
