export { Agent, type AgentConfig } from './application/agent/agent.js';
export { AgentBuilder } from './application/agent/agent-builder.js';
export { templateRegistry } from './application/template-registry.js';
export type { AgentTemplate } from './application/agent/config.js';
export type { ToolRoutingPolicy } from './application/chat/tool-policy.js';

export { buildSystemPrompt } from './application/prompt/system-prompt.js';
export type { BuiltSystemPrompt } from './application/prompt/system-prompt.js';
export {
  AGENT_MODES,
  AGENT_MODE_CYCLE,
  DEFAULT_AGENT_MODE,
  isAgentMode,
  nextAgentMode,
  resolveAgentMode,
  resolveModeDenied,
  resolveModeTools,
  type AgentMode,
  type AgentModeDef,
} from './domain/agent-mode.js';

export { createMessageContext } from './application/context/message-context.js';
export type { UsageBreakdown, MessageContext } from './application/context/message-context.js';

export type {
  AgentStreamEvent,
  LifecyclePhase,
  SubagentTaskPhase,
  ChatHandlers,
} from './domain/events.js';
export { emitEvent } from './domain/events.js';

export { ChatAbortedError, assertNotAborted } from './shared/chat-aborted.js';

export type {
  ModelProfile,
  ModelProviderKind,
  ProviderApiKeys,
} from './domain/model-profile.js';
export {
  DEFAULT_OPENAI_HOST,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_GROQ_HOST,
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GEMINI_HOST,
  DEFAULT_OPENROUTER_HOST,
  inferProviderFromHost,
  resolveApiKeyForProfile,
  resolveApiKeysFromEnv,
  formatProviderLabel,
  openRouterProfile,
  groqProfile,
  geminiProfile,
  openAiProfile,
  ollamaProfile,
  openRouterDefaultHeaders,
} from './domain/model-profile.js';

export { createLLMProvider } from './infrastructure/llm/create-provider.js';
export { OllamaProvider, OpenAIProvider } from './infrastructure/llm/providers.js';
export type {
  ChatMessage,
  ChatOptions,
  ChatResponse,
  LLMProvider,
  TokenUsage,
  ToolCall,
  AgentError,
} from './domain/llm.js';

export {
  loadSessionPrefs,
  saveLastMode,
  saveLastModelProfile,
  saveSessionPrefs,
} from './application/services/session-prefs.js';
export type { SessionPrefs } from './application/services/session-prefs.js';
export {
  resolveModelProfile,
  resolveModelProfileSync,
  findModelProfile,
  inferProfileForModel,
  rowToModelProfile,
} from './application/services/resolve-model-profile.js';
export {
  listAggregatedChatModels,
  listChatModelsEnvFromProcess,
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
  DELEGATE_TASK_TOOL_NAME,
  SUBAGENT_MAX_TOOL_ROUNDS,
  SUBAGENT_MODEL_ENV,
  SUBAGENT_READ_ONLY_TOOLS,
  isSubagentModelConfigured,
  readSubagentModelId,
} from './application/services/subagent-constants.js';
export {
  buildSubagentConfig,
  runSubagentTask,
} from './application/services/subagent-runner.js';
export type {
  SubagentChatCapable,
  SubagentRunResult,
  SubagentRunnerOptions,
} from './application/services/subagent-runner.js';
export { SubagentJobManager } from './application/services/subagent-job-manager.js';
export type {
  DelegateTaskStartResult,
  SubagentJobPhase,
  SubagentJobSnapshot,
  SubagentJobStartOptions,
} from './application/services/subagent-job-manager.js';
export {
  buildSubagentCancelledNotice,
  buildSubagentCompletionNotice,
  buildSubagentFailureNotice,
  previewSubagentContent,
} from './application/chat/subagent-result-gate.js';

export { taskRepository } from './infrastructure/persistence/task-repository.js';
export {
  findProjectDataDirWalk,
  resolvePoyrazGlobalDataDir,
  resolveProjectDataDir,
} from './infrastructure/persistence/paths.js';
export {
  applyWorkspaceFileLogging,
  findWorkspaceRoot,
  getActiveWorkspaceRoot,
  isWorkspaceFileLoggingEnabled,
  isWorkspaceTrustEnvOverride,
  readWorkspaceSettings,
  resolveWorkspaceLogDir,
  resolveWorkspacePoyrazDir,
  resolveWorkspaceSettingsPath,
  resolveWorkspaceTrust,
  setActiveWorkspaceRoot,
  writeWorkspaceSettings,
  type WorkspaceSettings,
} from './infrastructure/persistence/workspace-trust.js';
export {
  ensureTemplatesSynced,
  resolveBundledTemplatesDir,
  resolveGlobalTemplatesDir,
  syncBundledTemplatesToGlobal,
  type TemplateSyncResult,
} from './infrastructure/persistence/template-sync.js';
export {
  AUTH_PROVIDER_DEFS,
  authProviderFromModelKind,
  collectProjectAuthVars,
  collectProjectEnvPaths,
  collectProjectEnvVars,
  ensurePoyrazHome,
  importProjectAuthToPoyraz,
  loadAllEnv,
  loadPoyrazEnvIntoProcess,
  loadProjectEnvWalk,
  maskSecret,
  parseEnvLine,
  readEnvFile,
  readPoyrazAuthValues,
  resolveAuthProvider,
  resolvePoyrazEnvPath,
  resolvePoyrazHomeDir,
  setEnvVar,
  unsetEnvVar,
  type AuthProviderDef,
  type AuthProviderToken,
  type ImportAuthEntry,
  type ImportAuthResult,
} from './infrastructure/persistence/poyraz-home.js';

export { logger, LogLevel, configureFileLogging } from './shared/logger.js';
export type { FileLoggingConfig } from './shared/logger.js';

export {
  addMcpServer,
  getMcpServer,
  isMcpHttpServerDef,
  listMcpServers,
  loadMcpConfig,
  removeMcpServer,
  resolveMcpConfigPath,
  saveMcpConfig,
  setMcpServerDisabled,
  type McpConfig,
  type McpHttpServerDef,
  type McpServerDef,
  type McpServerEntry,
  type McpStdioServerDef,
} from './infrastructure/persistence/mcp-config.js';
export {
  mcpClientManager,
  type McpConnectionStatus,
  type McpServerState,
} from './infrastructure/mcp/mcp-client-manager.js';
export { MCP_TOOL_PREFIX, mcpToolName } from './infrastructure/mcp/mcp-tool-bridge.js';

export * from './tools/index.js';
export * from './presentation/ui/index.js';

export { TODO_CONTINUATION_BUDGET } from './application/chat/todo-completion-gate.js';
export * from './domain/task.js';
