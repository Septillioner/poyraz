export { Agent, type AgentConfig } from './application/agent/agent.js';
export { AgentBuilder } from './application/agent/agent-builder.js';
export {
  AgentConfigError,
  chainContinuation,
  DEFAULT_LOAD_SKILL_TOOL_NAME,
  DEFAULT_RATE_LIMIT_MAX_WAITS,
  resolveAgentPolicy,
  resolveRateLimitConfig,
  normalizeTokenPricing,
} from './application/agent/config.js';
export type {
  AgentMcpConfig,
  AgentTemplate,
  ContinuationContext,
  ContinuationDecision,
  ContinuationOutcome,
  ContinuationPolicy,
  LoggingConfig,
  PolicyConfig,
  RateLimitConfig,
  RepairConfig,
  ResolvedRateLimitConfig,
  OnSummarizedHook,
  SameToolBreakerConfig,
  Skill,
  SkillToolConfig,
  SummarizationConfig,
  SummarizedContext,
  SummaryPromptBuilder,
} from './application/agent/config.js';
export type { ToolRoutingPolicy } from './application/chat/tool-policy.js';

export { buildSystemPrompt } from './application/prompt/system-prompt.js';
export type { BuiltSystemPrompt } from './application/prompt/system-prompt.js';

export {
  DEFAULT_AGENT_POLICY,
  matchesAnyToolPattern,
  matchesToolPattern,
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
  type ErrorBreakerMode,
  type GateVerdict,
  type ResponseGate,
} from './domain/agent-policy.js';

export { createMessageContext } from './application/context/message-context.js';
export type {
  ContextOptions,
  MessageContext,
  MemoryUsage,
} from './application/context/message-context.js';

export {
  CONTEXT_CATEGORIES,
  emptyCategoryTokens,
} from './domain/context.js';
export type {
  CompiledRequest,
  CompiledToolSchema,
  CompileRequestOptions,
  ContextCategory,
  ContextCategoryTokens,
  ContextDrift,
  ContextEstimate,
  ContextMeter,
  ContextRealSnapshot,
  ContextRequestRecord,
  MessageContextMeta,
  SystemPromptParts,
  ToolSchemaCategory,
} from './domain/context.js';
export {
  categorizeMessage,
  buildMessageMeta,
} from './application/context/message-category.js';
export type { CategorizeOptions } from './application/context/message-category.js';
export {
  buildMeter,
  completeRecord,
  computeDrift,
  estimateRequest,
  realSnapshot,
  scaleCategoriesToTotal,
} from './application/context/context-report.js';
export type { EstimateRequestInput, MessageEntry } from './application/context/context-report.js';
export {
  createTokenEstimator,
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_MESSAGE_OVERHEAD_TOKENS,
} from './application/context/token-estimate.js';
export type {
  CalibrationSample,
  TokenEstimator,
  TokenEstimatorOptions,
} from './application/context/token-estimate.js';

export {
  buildSummaryPrompt,
  DEFAULT_SUMMARY_MESSAGE_PREFIX,
  DEFAULT_SUMMARY_PROMPT,
} from './application/context/summary-settings.js';

export {
  SUMMARY_MESSAGE_PREFIX,
  isSummaryMessage,
} from './application/context/summarizer.js';

export type {
  AgentStreamEvent,
  LifecyclePhase,
  ChatHandlers,
} from './domain/events.js';
export { emitEvent, rateLimitStreamEvent } from './domain/events.js';

export {
  isRateLimitError,
  isAbortError,
  parseDurationMs,
  rateLimitReason,
  resolveRateLimitDelay,
  sleepWithSignal,
  withRateLimitRetry,
  withRateLimitPolicy,
  DISABLED_RATE_LIMIT,
  RATE_LIMIT_DEFAULT_MAX_WAITS,
  RateLimitExceededError,
  RATE_LIMIT_FALLBACK_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
} from './infrastructure/llm/rate-limit.js';
export type {
  RateLimitDelay,
  RateLimitExceededReason,
  RateLimitRetryOptions,
} from './infrastructure/llm/rate-limit.js';

export { ChatAbortedError, assertNotAborted } from './shared/chat-aborted.js';

export type {
  ModelProfile,
  ModelProviderKind,
  ProviderApiKeys,
} from './domain/model-profile.js';
export {
  DEFAULT_OPENAI_HOST,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_LLAMACPP_HOST,
  LLAMACPP_MAX_TOOLS,
  LLAMACPP_ANONYMOUS_API_KEY,
  DEFAULT_GROQ_HOST,
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GEMINI_HOST,
  DEFAULT_OPENROUTER_HOST,
  inferProviderFromHost,
  resolveApiKeyForProfile,
  formatProviderLabel,
  openRouterProfile,
  groqProfile,
  geminiProfile,
  openAiProfile,
  ollamaProfile,
  llamaCppProfile,
  llamaCppApiBase,
  openRouterDefaultHeaders,
} from './domain/model-profile.js';

export { createLLMProvider } from './infrastructure/llm/create-provider.js';
export type { CreateProviderOptions } from './infrastructure/llm/create-provider.js';
export { OllamaProvider, OpenAIProvider } from './infrastructure/llm/providers.js';
export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  ReasoningConfig,
  ReasoningEffort,
  ServiceTier,
  TokenUsage,
  TokenPricing,
  TokenCost,
  TokenCostTotals,
  ToolCall,
  AgentError,
  RateLimitDelaySource,
  RateLimitNotice,
  RateLimitPolicy,
  RateLimitWait,
} from './domain/llm.js';
export { calculateTokenCost, isTokenPricing } from './domain/llm.js';

export {
  findModelProfile,
  inferProfileForModel,
  rowToModelProfile,
} from './application/services/resolve-model-profile.js';
export {
  listAggregatedChatModels,
  groupModelsByProvider,
  groupOpenRouterByTier,
  classifyOpenRouterTier,
} from './application/services/list-chat-models.js';
export type {
  ListedChatModelRow,
  ListChatModelsEnv,
  OpenRouterTier,
} from './application/services/list-chat-models.js';
export { fetchModelInfo, fetchModelInfoForId } from './application/services/model-info.js';
export type { ModelInfo } from './application/services/model-info.js';

export {
  LOAD_SKILL_TOOL_NAME,
  buildSkillCatalog,
  isSkillToolEnabled,
  resolveSkillToolName,
} from './tools/definitions/skills.js';

export {
  logger,
  Logger,
  LogLevel,
  createLogger,
  runWithLogger,
  scopeToLogger,
  configureFileLogging,
  getConfiguredLogDir,
  isFileLoggingEnabled,
} from './shared/logger.js';
export type { FileLoggingConfig, LoggerOptions } from './shared/logger.js';

export {
  isMcpHttpServerDef,
  type McpConfig,
  type McpHttpServerDef,
  type McpServerDef,
  type McpServerEntry,
  type McpStdioServerDef,
} from './domain/mcp.js';
export {
  McpClientManager,
  createMcpClientManager,
  mcpClientManager,
  type McpClientManagerOptions,
  type McpConnectionStatus,
  type McpServerState,
  type McpSyncOptions,
  type McpSyncResult,
} from './infrastructure/mcp/mcp-client-manager.js';
export {
  MCP_TOOL_PREFIX,
  isMcpToolName,
  mcpToolName,
  resolveMcpToolPrefix,
} from './infrastructure/mcp/mcp-tool-bridge.js';

export { builtinRepairResolvers } from './application/chat/repair-instruction.js';
export type { RepairInput, RepairOptions, RepairResolver } from './application/chat/repair-instruction.js';
export type { ToolExecutionOptions } from './application/chat/tool-execution.js';
export { limitToolResult } from './application/chat/tool-result-limit.js';
export type { LimitedToolResult, ToolResultLimit, ToolResultTruncation } from './application/chat/tool-result-limit.js';

export {
  isToolUseUnsupportedError,
  ToolUseUnsupportedError,
  TOOL_USE_UNSUPPORTED_CODE,
} from './infrastructure/llm/tool-use-unsupported.js';

export {
  MIN_CONTEXT_WINDOW_TOKENS,
  normalizeContextWindow,
  resolveContextWindow,
} from './application/context/context-window.js';
export type {
  ContextWindowLookup,
  ContextWindowQuery,
  ContextWindowResolution,
  ContextWindowSource,
  ResolveContextWindowOptions,
} from './application/context/context-window.js';

export { setActiveWorkspaceRoot } from './tools/core/shell-session.js';

export * from './tools/index.js';
export * from './presentation/ui/index.js';
