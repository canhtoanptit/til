import { EmbeddingError } from "./errors.js";
import { normalizeVector } from "./retrieval.js";
import type { Embedder } from "./types.js";

export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434";
export const OLLAMA_DEFAULT_MODEL = "bge-m3";
export const EMBEDDING_DIMENSIONS = 1024;
export const EMBEDDING_TIMEOUT_MS = 30_000;

const ERROR_DETAIL_MAX_CHARS = 200;

export interface OllamaEmbedderOptions {
  baseUrl?: string;
  model?: string;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

export class OllamaEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: OllamaEmbedderOptions = {}) {
    this.model = opts.model ?? OLLAMA_DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
    this.baseUrl = stripTrailingSlash(opts.baseUrl ?? OLLAMA_DEFAULT_BASE_URL);
    this.fetchImpl = opts.fetchImpl;
  }

  get endpoint(): string {
    return `${this.baseUrl}/api/embed`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const impl = this.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await impl(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EmbeddingError(
        `${this.label()}: request to ${this.endpoint} failed: ${describe(err)}`,
      );
    }

    if (!response.ok) {
      const detail = await readDetail(response);
      throw new EmbeddingError(
        `${this.label()}: ${this.endpoint} returned HTTP ${response.status}${detail}`,
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new EmbeddingError(
        `${this.label()}: response from ${this.endpoint} was not valid JSON`,
      );
    }

    return this.parseEmbeddings(body, texts.length);
  }

  private parseEmbeddings(body: unknown, expected: number): number[][] {
    if (typeof body !== "object" || body === null) {
      throw new EmbeddingError(`${this.label()}: response was not an object`);
    }
    const raw = (body as { embeddings?: unknown }).embeddings;
    if (!Array.isArray(raw)) {
      throw new EmbeddingError(
        `${this.label()}: response had no 'embeddings' array`,
      );
    }
    if (raw.length !== expected) {
      throw new EmbeddingError(
        `${this.label()}: expected ${expected} embeddings, got ${raw.length}`,
      );
    }

    const vectors: number[][] = [];
    for (const row of raw) {
      const vector = toNumbers(row);
      if (vector === undefined) {
        throw new EmbeddingError(
          `${this.label()}: response contained a non-numeric embedding`,
        );
      }
      // WHY: a dimension mismatch almost always means the wrong model was
      // pulled (e.g. nomic-embed-text at 768), so name both numbers.
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(
          `${this.label()}: expected ${this.dimensions}-dimensional embeddings, got ${vector.length} — is model '${this.model}' the right embedding model?`,
        );
      }
      vectors.push(normalizeVector(vector));
    }
    return vectors;
  }

  private label(): string {
    return `ollama embedder '${this.model}'`;
  }
}

export function createOllamaEmbedder(opts?: OllamaEmbedderOptions): Embedder {
  return new OllamaEmbedder(opts);
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

async function readDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return "";
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return "";
  const clipped =
    collapsed.length > ERROR_DETAIL_MAX_CHARS
      ? `${collapsed.slice(0, ERROR_DETAIL_MAX_CHARS)}…`
      : collapsed;
  return `: ${clipped}`;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
