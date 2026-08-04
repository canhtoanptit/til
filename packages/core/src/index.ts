export type {
  Candidate,
  Digest,
  DigestItemDraft,
  DigestSynthesis,
  Embedder,
  EvidenceCluster,
  Extractor,
  FetchCandidatesOptions,
  LLMClient,
  LLMSettings,
  ScoredCluster,
  SourceAdapter,
  StackMode,
  SynthesisInput,
  VectorMatch,
  VectorRecord,
  VectorStore,
} from "./types.js";
export {
  MAX_SYNTHESIS_PROMPT_CHARS,
  parseSynthesis,
} from "./prompt.js";
export {
  DigestError,
  EmbeddingError,
  ExtractionError,
  SourceError,
  UnsafeUrlError,
} from "./errors.js";
export { assertSafeUrl, gatewayBaseURL, normalizeUrl } from "./url.js";
export { createLLMClient } from "./factory.js";
export { DirectLLMClient } from "./direct-client.js";
export { AISDKClient } from "./ai-sdk-client.js";
export {
  clusterCandidates,
  scoreClusters,
  titleSimilarity,
  titleTokens,
} from "./ranking.js";
export {
  cosineSimilarity,
  embeddingTextFor,
  normalizeVector,
  RRF_K,
  rrfMerge,
} from "./retrieval.js";
export type { FusedId, RankedId } from "./retrieval.js";
export {
  createOllamaEmbedder,
  EMBEDDING_DIMENSIONS,
  EMBEDDING_TIMEOUT_MS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_MODEL,
  OllamaEmbedder,
} from "./ollama-embedder.js";
export type { OllamaEmbedderOptions } from "./ollama-embedder.js";
export {
  CHAT_SEARCH_DEFAULT_TOP_K,
  CHAT_SEARCH_MAX_TOP_K,
  CHAT_STATS_KINDS,
  CHAT_SYSTEM_PROMPT,
  CHAT_TOOL_DESCRIPTIONS,
  CHAT_TOOL_SCHEMAS,
} from "./chat.js";
export type { ChatToolName, StatsKind } from "./chat.js";
export {
  SOURCE_TIMEOUT_MS,
  SOURCE_USER_AGENT,
} from "./sources/http.js";
export { ArxivAdapter, createArxivAdapter } from "./sources/arxiv.js";
export type { ArxivAdapterOptions } from "./sources/arxiv.js";
export { createHNAdapter, HNAdapter } from "./sources/hn.js";
export type { HNAdapterOptions } from "./sources/hn.js";
export { createLobstersAdapter, LobstersAdapter } from "./sources/lobsters.js";
export type {
  LobstersAdapterOptions,
  LobstersFeed,
} from "./sources/lobsters.js";
export { createRssAdapter, feedSourceName, RssAdapter } from "./sources/rss.js";
export type { RssAdapterOptions } from "./sources/rss.js";
export { DEFAULT_RSS_FEEDS, defaultAdapters } from "./sources/registry.js";
export type { DefaultAdaptersOptions } from "./sources/registry.js";
