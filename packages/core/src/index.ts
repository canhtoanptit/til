export type {
  Candidate,
  Digest,
  DigestItemDraft,
  DigestKind,
  DigestSynthesis,
  Embedder,
  EvidenceCluster,
  ExtractedDocument,
  Extractor,
  FetchCandidatesOptions,
  LLMClient,
  LLMSettings,
  ReportContext,
  ScoredCluster,
  SourceAdapter,
  StackMode,
  SynthesisInput,
  SynthesisOptions,
  VectorMatch,
  VectorRecord,
  VectorStore,
} from "./types.js";
export { DIGEST_KINDS, isDigestKind } from "./types.js";
export {
  MAX_SYNTHESIS_PROMPT_CHARS,
  parseSynthesis,
  REPORT_SYSTEM_PROMPT,
  SYNTHESIS_SYSTEM_PROMPT,
  synthesisSystemPrompt,
} from "./prompt.js";
export {
  DigestError,
  EmbeddingError,
  ExtractionError,
  SourceError,
  UnsafeUrlError,
} from "./errors.js";
export { assertSafeUrl, gatewayBaseURL, normalizeUrl } from "./url.js";
export {
  CONTENT_TYPES,
  DEFAULT_CONTENT_TYPE,
  detectContentTypeFromUrl,
  isContentType,
  isPdfMediaType,
  isYoutubeHost,
  normalizeContentType,
  refineContentType,
  youtubeVideoId,
  youtubeWatchUrl,
} from "./content-type.js";
export type { ContentType } from "./content-type.js";
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
  compareIds,
  cosineSimilarity,
  embeddingTextFor,
  normalizeVector,
  RRF_K,
  rrfMerge,
  rrfScores,
} from "./retrieval.js";
export type { FusedId, RankedId, WeightedRanks } from "./retrieval.js";
export {
  ftsTokens,
  fuseHybrid,
  HYBRID_DEFAULTS,
  sanitizeFtsQuery,
  SELECTIVE_KEYWORD_HITS,
  STOPWORDS,
} from "./hybrid.js";
export type {
  FuseHybridOptions,
  HybridTiebreak,
  HybridWeights,
  KeywordVote,
  SanitizeFtsQueryOptions,
} from "./hybrid.js";
export {
  clampEase,
  clampIntervalDays,
  DAY_MS,
  EASE_DEFAULT,
  EASE_DELTA,
  EASE_MAX,
  EASE_MIN,
  EASY_BONUS,
  HARD_FACTOR,
  initialReviewCard,
  isReviewCardState,
  isReviewDue,
  isReviewGrade,
  ladderPosition,
  LEARNING_STEPS_DAYS,
  MAX_INTERVAL_DAYS,
  MIN_INTERVAL_DAYS,
  REVIEW_CARD_STATES,
  REVIEW_GRADES,
  scheduleReview,
} from "./review.js";
export type {
  ReviewCard,
  ReviewCardState,
  ReviewGrade,
  ReviewSchedule,
} from "./review.js";
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
  createWorkersAIRestEmbedder,
  WORKERS_AI_DEFAULT_MODEL,
  WORKERS_AI_REST_BASE_URL,
  WorkersAIRestEmbedder,
} from "./workers-ai-rest-embedder.js";
export type { WorkersAIRestEmbedderOptions } from "./workers-ai-rest-embedder.js";
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
  CHAT_DEFAULT_MAX_STEPS,
  chatNoticeResponse,
  describeChatStreamError,
  streamChat,
} from "./chat-stream.js";
export type { ChatTool, StreamChatOptions } from "./chat-stream.js";
export { SOURCE_TIMEOUT_MS, SOURCE_USER_AGENT } from "./sources/http.js";
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
