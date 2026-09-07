import { logger } from '../../shared/logger.js';
import type { ChatMessage, LLMProvider, TokenUsage } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { createLLMProvider } from '../../infrastructure/llm/create-provider.js';
import {
  inferProviderFromHost,
  resolveApiKeyForProfile,
} from '../../domain/model-profile.js';
import { toolRegistry } from '../../tools/core/registry.js';
import { MCP_TOOL_PREFIX } from '../../infrastructure/mcp/mcp-tool-bridge.js';
import type { ToolContext } from '../../tools/core/types.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { ChatHandlers } from '../../domain/events.js';
import { createMessageContext } from '../context/message-context.js';
import { applyContextManagement, summarizeHistory } from '../context/summarizer.js';
import { createTokenStats } from '../stats/token-stats.js';
import { buildSystemPrompt, BuiltSystemPrompt } from '../prompt/system-prompt.js';
import { buildActiveToolsSection } from '../prompt/tool-schema-hints.js';
import { inferPromptHintTier } from '../../domain/model-profile.js';
import { createToolPolicyGuard, type ToolRoutingPolicy } from '../chat/tool-policy.js';
import { runDecisionLoop } from '../chat/decision-loop.js';
import {
  writeChatDebugLog,
  type ChatDebugLogSource,
} from '../../infrastructure/persistence/chat-debug-log.js';
import { taskRepository } from '../../infrastructure/persistence/task-repository.js';
import { formatCurrentTodosPromptBlock } from '../../presentation/ui/todo-table.js';
import { resolvePersona } from './identity-resolver.js';
import {
  resolveAgentTools,
  resolveMaxToolRounds,
  resolveRepeatCallLimit,
} from './tool-resolver.js';
import type { AgentConfig } from './config.js';
import {
  AGENT_MODES,
  DEFAULT_AGENT_MODE,
  resolveModeDenied,
  resolveModeTools,
  type AgentMode,
} from '../../domain/agent-mode.js';
import type { TodoSnapshot } from '../../domain/task.js';

export type { AgentConfig };

export class Agent {
  private model: string;
  private options: Record<string, any> = {};
  private config: AgentConfig;
  private provider: LLMProvider;
  private baseTools: Record<string, ToolDefinition>;
  private tools: Record<string, ToolDefinition>;
  private name: string;
  private cachedToolSchemas: any[] = [];
  private policyConfig: ToolRoutingPolicy;
  private mode: AgentMode = DEFAULT_AGENT_MODE;
  private context = createMessageContext({ limit: 50, autoSummary: false, totalCapacity: 128000 });
  private stats = createTokenStats();
  private sessionId?: string;
  private builtPrompt?: BuiltSystemPrompt;
  private historyLoaded = false;
  private chatLogSource: ChatDebugLogSource = 'cli';
  private activeAbortSignal?: AbortSignal;
  private readonly toolContext: ToolContext = {};
  /** Cached <current_todos> block; refreshed before rounds. */
  private currentTodosBlock = '';

  constructor(config: AgentConfig) {
    this.config = config;
    this.name = config.name || 'Poyraz';
    this.model = config.model || 'gpt-4o';
    this.options = {
      temperature: 0.2,
      num_ctx: 4096,
      ...(config.options || {}),
    };
    this.policyConfig = {
      maxToolRounds: resolveMaxToolRounds(config),
      repeatCallLimit: resolveRepeatCallLimit(config),
      deterministicMode: config.routingPolicy?.deterministicMode ?? true,
      mode: this.mode,
    };
    this.context = createMessageContext({
      limit: config.contextLimit || 50,
      autoSummary: config.autoSummary || false,
      totalCapacity: this.options.num_ctx || 128000,
    });

    if (config.provider) {
      this.provider = config.provider;
    } else {
      const host = config.host || 'http://localhost:11434';
      const profile: ModelProfile = {
        model: this.model,
        host,
        provider: inferProviderFromHost(host),
      };
      this.provider = createLLMProvider(profile, config.apiKey);
    }

    this.baseTools = resolveAgentTools(config);
    this.tools = {};
    this.applyMode();

    if (config.logLevel !== undefined) {
      logger.setLevel(config.logLevel);
    }
  }

  private applyMode(): void {
    const allowed = resolveModeTools(Object.keys(this.baseTools), this.mode);
    const nextTools: Record<string, ToolDefinition> = {};
    for (const name of allowed) {
      const tool = this.baseTools[name];
      if (tool) nextTools[name] = tool;
    }
    this.tools = nextTools;
    this.cachedToolSchemas = toolRegistry.toOpenAISchemas(Object.keys(this.tools));
    this.policyConfig.deniedTools = resolveModeDenied(Object.keys(this.baseTools), this.mode);
    this.policyConfig.mode = this.mode;
  }

  /**
   * Adds externally sourced tools (e.g. from connected MCP servers) to this agent's tool set.
   * Registers each definition globally so schema/lookup paths shared with built-in tools keep working.
   */
  mergeExternalTools(tools: Record<string, ToolDefinition>): void {
    for (const tool of Object.values(tools)) {
      toolRegistry.register(tool);
    }
    this.baseTools = { ...this.baseTools, ...tools };
    this.applyMode();
    this.rebuildSystemPrompt();
  }

  /** Removes previously merged external tools whose name starts with `prefix` (default: MCP-bridged tools). */
  removeExternalTools(prefix: string = MCP_TOOL_PREFIX): void {
    const nextBaseTools: Record<string, ToolDefinition> = {};
    for (const [name, tool] of Object.entries(this.baseTools)) {
      if (name.startsWith(prefix)) {
        toolRegistry.unregister(name);
        continue;
      }
      nextBaseTools[name] = tool;
    }
    this.baseTools = nextBaseTools;
    this.applyMode();
    this.rebuildSystemPrompt();
  }

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    this.mode = mode;
    this.applyMode();
    this.rebuildSystemPrompt();
  }

  rebuildSystemPrompt(): BuiltSystemPrompt {
    const built = buildSystemPrompt({
      modeDirective: AGENT_MODES[this.mode].directive,
      persona: resolvePersona(this.config),
      activeToolsSection: buildActiveToolsSection(
        Object.keys(this.tools),
        inferPromptHintTier(this.model)
      ),
      currentTodosSection: this.currentTodosBlock || undefined,
    });
    this.builtPrompt = built;

    const systemMessage: ChatMessage = { role: 'system', content: built.content };
    const msgs = this.context.getMessagesCopy();

    if (msgs.length === 0) {
      this.context.setMessages([systemMessage]);
    } else if (msgs[0].role === 'system') {
      msgs[0] = systemMessage;
      this.context.setMessages(msgs);
    } else {
      this.context.setMessages([systemMessage, ...msgs]);
    }

    return built;
  }

  async refreshCurrentTodosBlock(): Promise<void> {
    const snapshot = await this.getTodoSnapshot();
    this.currentTodosBlock = formatCurrentTodosPromptBlock(snapshot);
  }

  async init() {
    this.rebuildSystemPrompt();
    logger.debug('Agent initialized', { name: this.name, model: this.model });
  }

  loadHistory(messages: ChatMessage[]) {
    this.historyLoaded = true;
    const sysMsg = this.context.getMessages()[0];
    const filtered = messages.filter((m, i) => !(m.role === 'system' && i === 0));
    this.context.setMessages(sysMsg ? [sysMsg, ...filtered] : filtered);
  }

  getHistory() {
    return this.context.getMessages();
  }

  getContextUsage() {
    return this.context.getUsage();
  }

  getMemoryUsage() {
    return this.context.getMemoryUsage();
  }

  getUsageBreakdown() {
    return this.context.getUsageBreakdown();
  }

  getStats() {
    return {
      current: this.stats.getCurrent(),
      session: this.stats.getSessionTotal(),
    };
  }

  setSessionUsage(usage: TokenUsage) {
    this.stats.setSessionTotal(usage);
  }

  getName() {
    return this.name;
  }

  getModel() {
    return this.model;
  }

  setModel(model: string) {
    this.model = model;
  }

  getModelProfile(): ModelProfile {
    const host = this.config.host || 'http://localhost:11434';
    return {
      model: this.model,
      host,
      provider: inferProviderFromHost(host),
    };
  }

  setModelProfile(profile: ModelProfile): void {
    this.model = profile.model;
    this.config.host = profile.host;
    this.config.apiKey = resolveApiKeyForProfile(profile);
    this.provider = createLLMProvider(profile, this.config.apiKey);
    this.rebuildSystemPrompt();
  }

  setSessionId(id: string) {
    this.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async getTodoSnapshot(): Promise<TodoSnapshot> {
    return taskRepository.getSnapshot(this.sessionId);
  }

  getCachedTodoSnapshot(): TodoSnapshot {
    return taskRepository.getCachedSnapshot(this.sessionId);
  }

  setChatLogSource(source: ChatDebugLogSource) {
    this.chatLogSource = source;
  }

  getTools() {
    return Object.keys(this.tools);
  }

  getApiKeyPreview() {
    if (!this.config.apiKey) return null;
    const key = this.config.apiKey.trim();
    if (key.length < 8) return 'Invalid';
    return `sk-...${key.slice(-4)}`;
  }

  getConfig() {
    return this.config;
  }

  getMessageHistory(): ChatMessage[] {
    return this.context.getMessagesCopy();
  }

  getPromptCacheKey(): string | undefined {
    if (!this.builtPrompt) return undefined;
    return `${this.name}:${this.builtPrompt.cacheKey}`;
  }

  async chat(userInput: string, handlers?: ChatHandlers): Promise<{ content: string; usage: TokenUsage }> {
    this.context.addMessage({ role: 'user', content: userInput });
    this.stats.resetCurrent();
    this.activeAbortSignal = handlers?.signal;

    logger.info('User message received', { agent: this.name, input: userInput });

    let result: { content: string; usage: TokenUsage } | undefined;
    let chatError: string | undefined;

    try {
      await this.refreshCurrentTodosBlock();
      this.rebuildSystemPrompt();

      const policyGuard = createToolPolicyGuard(this.policyConfig);
      policyGuard.reset();

      const loopResult = await runDecisionLoop(
        {
          provider: this.provider,
          model: this.model,
          options: this.options,
          tools: this.cachedToolSchemas,
          policy: this.policyConfig,
          promptCacheKey: this.getPromptCacheKey(),
          promptCacheRetention: this.config.promptCacheRetention,
          mode: this.mode,
        },
        this.tools,
        policyGuard,
        {
          getMessages: () => this.context.getMessages(),
          addMessage: (message) => this.context.addMessage(message),
          onEvent: handlers?.onEvent,
          onUsage: (usage) => this.stats.addUsage(usage),
          buildToolContext: () => this.buildToolContext(),
          getPromptCacheKey: () => this.getPromptCacheKey(),
          signal: handlers?.signal,
          getTodoSnapshot: () => this.getTodoSnapshot(),
          onBeforeRound: async () => {
            await this.refreshCurrentTodosBlock();
            this.rebuildSystemPrompt();
          },
        }
      );

      await applyContextManagement(
        this.context,
        this.config.autoSummary || false,
        handlers,
        () => summarizeHistory(this.context, this.provider, this.model, handlers)
      );

      result = { content: loopResult.content, usage: this.stats.getCurrent() };
      return result;
    } catch (error: any) {
      chatError = error.message;
      logger.error('Chat error', { error: error.message });
      throw error;
    } finally {
      this.activeAbortSignal = undefined;
      void writeChatDebugLog({
        timestamp: new Date().toISOString(),
        source: this.chatLogSource,
        sessionId: this.sessionId,
        agentName: this.name,
        model: this.model,
        userInput,
        systemPrompt: this.builtPrompt?.content ?? null,
        messages: this.context.getMessagesCopy(),
        usage: result?.usage ?? this.stats.getCurrent(),
        error: chatError,
      });
    }
  }

  private buildToolContext(): ToolContext {
    this.toolContext.agent = this;
    this.toolContext.logger = logger;
    this.toolContext.sessionId = this.sessionId;
    this.toolContext.abortSignal = this.activeAbortSignal;
    this.toolContext.refreshSystemPrompt = () => {
      this.rebuildSystemPrompt();
    };
    return this.toolContext;
  }
}
