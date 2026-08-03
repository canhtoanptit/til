export type {
  Candidate,
  Digest,
  EvidenceCluster,
  Extractor,
  FetchCandidatesOptions,
  LLMClient,
  LLMSettings,
  ScoredCluster,
  SourceAdapter,
} from "./types.js";
export {
  DigestError,
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
