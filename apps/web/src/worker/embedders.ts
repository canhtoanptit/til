import {
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  normalizeVector,
} from "@til/core";
import type { Embedder } from "@til/core";

export const EMBED_MODEL = "bge-m3";
export const WORKERS_AI_EMBED_MODEL = "@cf/baai/bge-m3";

interface WorkersAiEmbedResponse {
  shape?: number[];
  data?: unknown;
}

export interface AiRunLike {
  run(
    model: string,
    input: { text: string | string[] },
  ): Promise<WorkersAiEmbedResponse>;
}

/** Workers AI `@cf/baai/bge-m3`; used in `TIL_STACK=cloud`. */
export class WorkersAIEmbedder implements Embedder {
  readonly model = EMBED_MODEL;
  readonly dimensions = EMBEDDING_DIMENSIONS;
  private readonly ai: AiRunLike;

  constructor(ai: AiRunLike) {
    this.ai = ai;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    let response: WorkersAiEmbedResponse;
    try {
      response = await this.ai.run(WORKERS_AI_EMBED_MODEL, { text: texts });
    } catch (err) {
      throw new EmbeddingError(
        `${this.label()}: env.AI.run failed: ${describeError(err)}`,
      );
    }

    const rows = response.data;
    if (!Array.isArray(rows)) {
      throw new EmbeddingError(`${this.label()}: response had no 'data' array`);
    }
    if (rows.length !== texts.length) {
      throw new EmbeddingError(
        `${this.label()}: expected ${texts.length} embeddings, got ${rows.length}`,
      );
    }

    const vectors: number[][] = [];
    for (const row of rows) {
      const vector = toNumbers(row);
      if (vector === undefined) {
        throw new EmbeddingError(
          `${this.label()}: response contained a non-numeric embedding`,
        );
      }
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(
          `${this.label()}: expected ${this.dimensions}-dimensional embeddings, got ${vector.length}`,
        );
      }
      // Workers AI is documented as returning normalized vectors, but the two
      // stacks must rank identically, so normalize rather than trust it.
      vectors.push(normalizeVector(vector));
    }
    return vectors;
  }

  private label(): string {
    return `workers-ai embedder '${WORKERS_AI_EMBED_MODEL}'`;
  }
}

export function isAiRunLike(ai: unknown): ai is AiRunLike {
  return (
    typeof ai === "object" &&
    ai !== null &&
    typeof (ai as AiRunLike).run === "function"
  );
}

function toNumbers(row: unknown): number[] | undefined {
  if (!Array.isArray(row)) return undefined;
  const out: number[] = [];
  for (const value of row) {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    out.push(value);
  }
  return out;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
