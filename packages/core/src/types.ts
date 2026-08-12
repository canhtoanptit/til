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

/**
 * What flavour of run a digest is. 'weekly' is the roundup of external
 * candidates; 'monthly-report' is a retrospective over the owner's own saved
 * entries. Mirrored by `digests.kind` (migration 0011). Declared as a tuple so a
 * zod enum and a JSON-schema enum can both be built from it — same shape as
 * `CHAT_STATS_KINDS`.
 */
export const DIGEST_KINDS = ["weekly", "monthly-report"] as const;

export type DigestKind = (typeof DIGEST_KINDS)[number];

export function isDigestKind(value: unknown): value is DigestKind {
  return (
    typeof value === "string" &&
    (DIGEST_KINDS as readonly string[]).includes(value)
  );
}

/**
 * One thing the model may select and write about. Both flavours of synthesis
 * share this shape so there is one `synthesizeDigest` seam and one set of
 * provider plumbing behind it; the fields that only one flavour can fill are
 * optional and documented per-flavour.
 */
export interface SynthesisInput {
  canonicalUrl: string;
  title: string;
  /**
   * Weekly: the source adapters that surfaced this link. Monthly report: the one
   * domain the owner saved it from — a saved entry has exactly one origin.
   */
  sources: string[];
  /** Weekly: when it was published. Monthly report: when the owner saved it. */
  publishedAt: number;
  /**
   * The score the pool was ordered by. Absent on the monthly report, which has no
   * ranking at all: the owner's saves are ordered by recency and choosing the
   * notable ones is the model's whole job there. Absent is rendered as "n/a"
   * rather than 0, so a missing score can never read as "scored zero".
   */
  score?: number;
  /** Weekly: the candidate's snippet. Monthly report: the entry's takeaway. */
  snippet?: string;
  /** Monthly report only: the tags the owner's entry carries. */
  tags?: string[];
}

/**
 * The month's aggregates, passed alongside the entries so the retrospective can
 * open with real numbers instead of inferring them from the list it was shown
 * (which is capped for length and would undercount).
 */
export interface ReportContext {
  saved: number;
  ready: number;
  pending: number;
  failed: number;
  topDomains: { domain: string; count: number }[];
  topTags: { tag: string; count: number }[];
  /** Review cards graded inside the window; 0 when the owner reviewed nothing. */
  reviewsGraded: number;
}

export interface SynthesisOptions {
  windowDays: number;
  maxItems: number;
  /** Which prompt flavour to use. Omitted means "weekly", the original behaviour. */
  kind?: DigestKind;
  /** Required in practice for 'monthly-report'; ignored for 'weekly'. */
  report?: ReportContext;
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
    opts: SynthesisOptions,
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
  /**
   * The stored vector for one id, or null when there is nothing usable — the id
   * has no vector, or the stored one no longer matches the index's dimensions.
   * Implementations MUST NOT hand back an off-dimension vector: the only thing a
   * caller can do with the result is feed it to `query`, which rejects those.
   */
  getVector(id: string): Promise<number[] | null>;
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
