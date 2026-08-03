export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}

interface VectorizeUpsertVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorizeLike {
  upsert(vectors: VectorizeUpsertVector[]): Promise<unknown>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

interface EmbedResponse {
  shape?: number[];
  data?: number[][];
}

interface AiRunLike {
  run(model: string, input: { text: string | string[] }): Promise<EmbedResponse>;
}

export class WorkersAIEmbedder implements EmbeddingClient {
  private readonly ai: AiRunLike;
  constructor(ai: AiRunLike) {
    this.ai = ai;
  }
  async embed(text: string): Promise<number[]> {
    const res = await this.ai.run("@cf/baai/bge-m3", { text });
    const first = res.data?.[0];
    if (!Array.isArray(first)) {
      throw new Error("bge-m3 returned no embedding vector");
    }
    return first;
  }
}

export function embeddingTextFor(input: {
  title: string | null;
  summary: string | null;
  takeaway: string | null;
  tags: string[];
}): string {
  const { title, summary, takeaway, tags } = input;
  return `${title ?? ""}\n${takeaway ?? ""}\n${summary ?? ""}\nTags: ${tags.join(", ")}`;
}
