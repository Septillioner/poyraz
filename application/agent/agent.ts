import { logger } from '../../shared/logger.js';
import type { ChatMessage, LLMProvider, TokenUsage } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { createLLMProvider } from '../../infrastructure/llm/create-provider.js';
import { inferProviderFromHost } from '../../domain/model-profile.js';
import { toolRegistry, toOpenAISchema } from '../../tools/core/registry.js';
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  normalizeSkills,
} from '../../tools/definitions/skills.js';
// Side-effect: register built-in tools before resolveAgentTools reads the registry.
import '../../tools/index.js';
import { MCP_TOOL_PREFIX } from '../../infrastructure/mcp/mcp-tool-bridge.js';
import type { ToolContext } from '../../tools/core/types.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { AgentStreamEvent, ChatHandlers } from '../../domain/events.js';
import { createMessageContext } from '../context/message-context.js';
import { applyContextManagement, summarizeHistory } from '../context/summarizer.js';
import { createTokenStats } from '../stats/token-stats.js';
import { buildSystemPrompt, BuiltSystemPrompt } from '../prompt/system-prompt.js';
import { createToolPolicyGuard, type ToolRoutingPolicy } from '../chat/tool-policy.js';
import { runDecisionLoop } from '../chat/decision-loop.js';
import {
  writeChatDebugLog,
  type ChatDebugLogSource,
} from '../../infrastructure/persistence/chat-debug-log.js';
import {
  resolveAgentTools,
  resolveMaxToolRounds,
  resolveRepeatCallLimit,
} from './tool-resolver.js';
import type { AgentConfig } from './config.js';
import {
  DEFAULT_AGENT_POLICY,
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
} from '../../domain/agent-policy.js';
import type { TodoStore } from '../../domain/todo-store.js';
import { createInMemoryTodoStore } from '../../infrastructure/persistence/in-memory-todo-store.js';
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
  private policy: AgentPolicy;
  private todoStore: TodoStore;
  private context = createMessageContext({});
  private stats = createTokenStats();
  private sessionId?: string;
  private builtPrompt?: BuiltSystemPrompt;
  private historyLoaded = false;
  private chatLogSource: ChatDebugLogSource = 'cli';
  private activeAbortSignal?: AbortSignal;
  private readonly toolContext: ToolContext = {};

  constructor(config: AgentConfig) {
    this.config = config;
    this.name = config.name || 'Poyraz';
    this.model = config.model || 'gpt-4o';
    this.options = {
      temperature: 0.2,
      num_ctx: 4096,
      ...(config.options || {}),
    };
    this.policy = config.policy ?? { ...DEFAULT_AGENT_POLICY };
    this.todoStore = config.todoStore ?? createInMemoryTodoStore();
    this.policyConfig = {
      maxToolRounds: resolveMaxToolRounds(config),
      repeatCallLimit: resolveRepeatCallLimit(config),
      deterministicMode: config.routingPolicy?.deterministicMode ?? true,
      deniedToolReason: this.policy.deniedToolReason,
      perTurnToolLimits: this.policy.perTurnToolLimits,
    };
    this.context = createMessageContext({
      limit: config.contextLimit,
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
    this.syncSkillTool();
    this.applyPolicy();

    if (config.logLevel !== undefined) {
      logger.setLevel(config.logLevel);
    }
  }

  /**
   * Adds or removes `delegate_task` from the live tool set based on agent delegation config.
   */
  private syncSkillTool(): void {
    const skills = normalizeSkills(this.config.skills);
    this.config.skills = skills.length > 0 ? skills : undefined;
    const excluded = this.config.excludeTools?.includes(LOAD_SKILL_TOOL_NAME) ?? false;

    if (skills.length === 0 || excluded) {
      if (!this.baseTools[LOAD_SKILL_TOOL_NAME]) return;
      delete this.baseTools[LOAD_SKILL_TOOL_NAME];
      this.applyPolicy();
      return;
    }

    this.baseTools[LOAD_SKILL_TOOL_NAME] = createLoadSkillTool(skills);
    this.applyPolicy();
  }

  private applyPolicy(): void {
    const allowed = resolvePolicyTools(Object.keys(this.baseTools), this.policy);
    const nextTools: Record<string, ToolDefinition> = {};
    for (const name of allowed) {
      const tool = this.baseTools[name];
      if (tool) nextTools[name] = tool;
    }
    this.tools = nextTools;
    this.cachedToolSchemas = Object.values(this.tools).map((tool) => toOpenAISchema(tool));
    this.policyConfig.deniedTools = resolvePolicyDenied(Object.keys(this.baseTools), this.policy);
    this.policyConfig.deniedToolReason = this.policy.deniedToolReason;
    this.policyConfig.perTurnToolLimits = this.policy.perTurnToolLimits;
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
    this.applyPolicy();
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
    this.applyPolicy();
  }

  getPolicy(): AgentPolicy {
    return this.policy;
  }

  setPolicy(policy: AgentPolicy): void {
    this.policy = policy;
    this.applyPolicy();
  }

  setSystemPrompt(text: string): void {
    this.config.systemPrompt = text;
    this.rebuildSystemPrompt();
  }

  rebuildSystemPrompt(): BuiltSystemPrompt {
    const built = buildSystemPrompt(this.config.systemPrompt, this.config.rules);
    this.builtPrompt = built;

    const msgs = this.context.getMessagesCopy();
    const hasSystem = msgs.length > 0 && msgs[0].role === 'system';
    const previousContent = hasSystem ? msgs[0].content : '';

    if (!built.content.trim()) {
      if (hasSystem) {
        this.context.setMessages(msgs.slice(1));
      }
      return built;
    }

    if (hasSystem && previousContent === built.content) {
      return built;
    }

    const systemMessage: ChatMessage = { role: 'system', content: built.content };

    if (msgs.length === 0) {
      this.context.setMessages([systemMessage]);
    } else if (hasSystem) {
      msgs[0] = systemMessage;
      this.context.setMessages(msgs);
    } else {
      this.context.setMessages([systemMessage, ...msgs]);
    }

    return built;
  }

  async init() {
    this.rebuildSystemPrompt();
    logger.debug('Agent initialized', { name: this.name, model: this.model });
  }

  loadHistory(messages: ChatMessage[]) {
    this.historyLoaded = true;
    const existing = this.context.getMessages();
    const sysMsg = existing[0]?.role === 'system' ? existing[0] : undefined;
    const filtered = messages.filter((m, i) => !(m.role === 'system' && i === 0));
    this.context.setMessages(sysMsg ? [sysMsg, ...filtered] : filtered);
  }

  getHistory() {
    return this.context.getMessages();
  }

  getMemoryUsage() {
    return this.context.getMemoryUsage();
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

  /** Rolls delegated/subagent provider usage into this agent's session and current totals. */
  recordExternalUsage(usage: TokenUsage): void {
    this.stats.addUsage(usage);
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

  setModelProfile(profile: ModelProfile, apiKey: string): void {
    this.model = profile.model;
    this.config.host = profile.host;
    this.config.apiKey = apiKey;
    this.provider = createLLMProvider(profile, apiKey);
  }

  setSessionId(id: string) {
    this.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  async getTodoSnapshot(): Promise<TodoSnapshot> {
    return this.todoStore.getSnapshot(this.sessionId);
  }

  getCachedTodoSnapshot(): TodoSnapshot | null {
    return this.todoStore.getCachedSnapshot(this.sessionId);
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

  /** Compact older turns into a single rolling user summary message. */
  async summarize(handlers?: ChatHandlers): Promise<void> {
    await summarizeHistory(this.context, this.provider, this.model, handlers, this.config.serviceTier);
  }

  async chat(userInput: string, handlers?: ChatHandlers): Promise<{ content: string; usage: TokenUsage; contextUsage?: TokenUsage }> {
    this.context.addMessage({ role: 'user', content: userInput });
    this.stats.resetCurrent();
    this.activeAbortSignal = handlers?.signal;

    logger.info('User message received', { agent: this.name, input: userInput });

    let result: { content: string; usage: TokenUsage } | undefined;
    let chatError: string | undefined;

    try {
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
          reasoning: this.config.reasoning,
          serviceTier: this.config.serviceTier,
          agentPolicy: this.policy,
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
        }
      );

      await applyContextManagement(
        this.context,
        this.config.autoSummary || false,
        handlers,
        () => this.summarize(handlers)
      );

      result = { content: loopResult.content, usage: this.stats.getCurrent() };
      // Billing includes every tool round; context occupancy is the last request only.
      return { ...result, contextUsage: loopResult.usage };
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
    this.toolContext.todoStore = this.todoStore;
    return this.toolContext;
  }
}
