import { EmbeddingError } from "./errors.js";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_TIMEOUT_MS,
} from "./ollama-embedder.js";
import { normalizeVector } from "./retrieval.js";
import type { Embedder } from "./types.js";

export const WORKERS_AI_REST_BASE_URL = "https://api.cloudflare.com/client/v4";
export const WORKERS_AI_DEFAULT_MODEL = "bge-m3";

const ERROR_DETAIL_MAX_CHARS = 200;

export interface WorkersAIRestEmbedderOptions {
  accountId: string;
  apiToken: string;
  /** Short name, e.g. `bge-m3`; the `@cf/baai/` prefix is added for the path. */
  model?: string;
  dimensions?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Workers AI `@cf/baai/bge-m3` over the plain REST API, for hosts with no
 * `env.AI` binding: `TIL_STACK=local` on a machine that cannot run Ollama, and
 * the eval harness, which runs in Node (ADR-0010 amendment).
 */
export class WorkersAIRestEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: WorkersAIRestEmbedderOptions) {
    const accountId = opts.accountId.trim();
    const apiToken = opts.apiToken.trim();
    if (accountId.length === 0) {
      throw new EmbeddingError("workers-ai rest embedder: accountId is empty.");
    }
    if (apiToken.length === 0) {
      throw new EmbeddingError("workers-ai rest embedder: apiToken is empty.");
    }
    this.accountId = accountId;
    this.apiToken = apiToken;
    this.model = opts.model ?? WORKERS_AI_DEFAULT_MODEL;
    this.dimensions = opts.dimensions ?? EMBEDDING_DIMENSIONS;
    this.fetchImpl = opts.fetchImpl;
  }

  /** The full Workers AI model id, as the REST path spells it. */
  get restModel(): string {
    return this.model.startsWith("@") ? this.model : `@cf/baai/${this.model}`;
  }

  get endpoint(): string {
    return `${WORKERS_AI_REST_BASE_URL}/accounts/${this.accountId}/ai/run/${this.restModel}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const impl = this.fetchImpl ?? globalThis.fetch;
    let response: Response;
    try {
      response = await impl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiToken}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ text: texts }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
    } catch (err) {
      throw new EmbeddingError(
        `${this.label()}: request to ${this.safeEndpoint()} failed: ${this.scrub(describe(err))}`,
      );
    }

    if (!response.ok) {
      const detail = await this.readDetail(response);
      throw new EmbeddingError(
        `${this.label()}: ${this.safeEndpoint()} returned HTTP ${response.status}${detail}${hint(response.status)}`,
      );
    }

    let body: unknown;
    try {
      body = (await response.json()) as unknown;
    } catch {
      throw new EmbeddingError(
        `${this.label()}: response from ${this.safeEndpoint()} was not valid JSON`,
      );
    }

    return this.parseEmbeddings(body, texts.length);
  }

  private parseEmbeddings(body: unknown, expected: number): number[][] {
    if (typeof body !== "object" || body === null) {
      throw new EmbeddingError(`${this.label()}: response was not an object`);
    }
    const envelope = body as { success?: unknown; errors?: unknown };
    // The REST API answers 200 with `success:false` for some model-level
    // failures, so the envelope has to be checked even on a 2xx.
    if (envelope.success === false) {
      throw new EmbeddingError(
        `${this.label()}: API reported success:false${this.describeApiErrors(envelope.errors)}`,
      );
    }

    const result = (body as { result?: unknown }).result;
    if (typeof result !== "object" || result === null) {
      throw new EmbeddingError(`${this.label()}: response had no 'result'`);
    }
    const raw = (result as { data?: unknown }).data;
    if (!Array.isArray(raw)) {
      throw new EmbeddingError(
        `${this.label()}: response had no 'result.data' array`,
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
      if (vector.length !== this.dimensions) {
        throw new EmbeddingError(
          `${this.label()}: expected ${this.dimensions}-dimensional embeddings, got ${vector.length} — is model '${this.restModel}' the right embedding model?`,
        );
      }
      // Workers AI is documented as returning normalized vectors; the two stacks
      // must rank identically, so normalize rather than trust it.
      vectors.push(normalizeVector(vector));
    }
    return vectors;
  }

  private describeApiErrors(errors: unknown): string {
    if (!Array.isArray(errors) || errors.length === 0) return "";
    const parts: string[] = [];
    for (const error of errors) {
      if (typeof error === "string") {
        parts.push(error);
        continue;
      }
      if (typeof error !== "object" || error === null) continue;
      const { code, message } = error as { code?: unknown; message?: unknown };
      const text = typeof message === "string" ? message : "";
      const label = typeof code === "number" ? `${code}` : "";
      const joined = [label, text].filter((p) => p.length > 0).join(" ");
      if (joined.length > 0) parts.push(joined);
    }
    if (parts.length === 0) return "";
    return `: ${this.scrub(clip(parts.join("; ")))}`;
  }

  private async readDetail(response: Response): Promise<string> {
    let text: string;
    try {
      text = await response.text();
    } catch {
      return "";
    }
    const collapsed = text.replace(/\s+/g, " ").trim();
    if (collapsed.length === 0) return "";
    return `: ${this.scrub(clip(collapsed))}`;
  }

  /** Account ids are not secret, but they need not travel in error prose. */
  private safeEndpoint(): string {
    return `${WORKERS_AI_REST_BASE_URL}/accounts/{account_id}/ai/run/${this.restModel}`;
  }

  // WHY: these messages reach logs and the eval report, and a token echoed back
  // by the API (or embedded in a transport error) must not survive that trip.
  private scrub(text: string): string {
    return text.split(this.apiToken).join("[redacted]");
  }

  private label(): string {
    return `workers-ai rest embedder '${this.restModel}'`;
  }
}

export function createWorkersAIRestEmbedder(
  opts: WorkersAIRestEmbedderOptions,
): Embedder {
  return new WorkersAIRestEmbedder(opts);
}

function hint(status: number): string {
  if (status === 401 || status === 403) {
    return " — check CF_ACCOUNT_ID and that WORKERS_AI_API_TOKEN carries the Workers AI Read permission";
  }
  if (status === 404) {
    return " — check CF_ACCOUNT_ID and the model name";
  }
  if (status === 429) {
    return " — Workers AI rate limit; retry or batch fewer texts";
  }
  return "";
}

function clip(text: string): string {
  return text.length > ERROR_DETAIL_MAX_CHARS
    ? `${text.slice(0, ERROR_DETAIL_MAX_CHARS)}…`
    : text;
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

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
