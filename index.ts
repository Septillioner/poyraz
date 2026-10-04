export { Agent, type AgentConfig } from './application/agent/agent.js';
export { AgentBuilder } from './application/agent/agent-builder.js';
export type { AgentTemplate, Skill } from './application/agent/config.js';
export type { ToolRoutingPolicy } from './application/chat/tool-policy.js';

export { buildSystemPrompt, BASE_PROMPT } from './application/prompt/system-prompt.js';
export type { BuiltSystemPrompt } from './application/prompt/system-prompt.js';

export {
  DEFAULT_AGENT_POLICY,
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
  type GateVerdict,
  type ResponseGate,
} from './domain/agent-policy.js';

export { createMessageContext } from './application/context/message-context.js';
export type { MessageContext, MemoryUsage } from './application/context/message-context.js';

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
  RATE_LIMIT_FALLBACK_DELAY_MS,
  RATE_LIMIT_MAX_DELAY_MS,
  RATE_LIMIT_MIN_DELAY_MS,
} from './infrastructure/llm/rate-limit.js';
export type { RateLimitDelay, RateLimitRetryOptions } from './infrastructure/llm/rate-limit.js';

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
  ToolCall,
  AgentError,
  RateLimitDelaySource,
  RateLimitNotice,
  RateLimitWait,
} from './domain/llm.js';

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

export { LOAD_SKILL_TOOL_NAME } from './tools/definitions/skills.js';

export {
  logger,
  LogLevel,
  configureFileLogging,
  getConfiguredLogDir,
  isFileLoggingEnabled,
} from './shared/logger.js';
export type { FileLoggingConfig } from './shared/logger.js';

export {
  isMcpHttpServerDef,
  type McpConfig,
  type McpHttpServerDef,
  type McpServerDef,
  type McpServerEntry,
  type McpStdioServerDef,
} from './domain/mcp.js';
export {
  mcpClientManager,
  type McpConnectionStatus,
  type McpServerState,
} from './infrastructure/mcp/mcp-client-manager.js';
export { MCP_TOOL_PREFIX, mcpToolName } from './infrastructure/mcp/mcp-tool-bridge.js';

export { setActiveWorkspaceRoot } from './tools/core/shell-session.js';

export * from './tools/index.js';
export * from './presentation/ui/index.js';
