import { createLogger, logger, scopeToLogger, type Logger } from '../../shared/logger.js';
import {
  calculateTokenCost,
  type ChatMessage,
  type LLMProvider,
  type ReasoningConfig,
  type ServiceTier,
  type TokenCostTotals,
  type TokenPricing,
  type TokenUsage,
} from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { createLLMProvider } from '../../infrastructure/llm/create-provider.js';
import { inferProviderFromHost } from '../../domain/model-profile.js';
import { createToolRegistry, toolRegistry, toOpenAISchema, type ToolRegistry } from '../../tools/core/registry.js';
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  normalizeSkills,
} from '../../tools/definitions/skills.js';
// Side-effect: registers the built-in tools in the shared `toolRegistry`. Builders and agents layer their
// own registry over it (presets / `WithTools` resolve against it); importing it selects nothing.
import '../../tools/index.js';
import { MCP_TOOL_PREFIX, resolveMcpToolPrefix } from '../../infrastructure/mcp/mcp-tool-bridge.js';
import type {
  McpClientManager,
  McpServerState,
  McpSyncOptions,
  McpSyncResult,
} from '../../infrastructure/mcp/mcp-client-manager.js';
import type { McpServerDef } from '../../domain/mcp.js';
import { withRateLimitPolicy } from '../../infrastructure/llm/rate-limit.js';
import type { ToolContext } from '../../tools/core/types.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { AgentStreamEvent, ChatHandlers } from '../../domain/events.js';
import { createMessageContext } from '../context/message-context.js';
import {
  buildMeter,
  completeRecord,
  estimateRequest,
  realSnapshot,
} from '../context/context-report.js';
import { createTokenEstimator, type TokenEstimator } from '../context/token-estimate.js';
import { MIN_CONTEXT_WINDOW_TOKENS, normalizeContextWindow } from '../context/context-window.js';
import {
  emptyCategoryTokens,
  type CompiledRequest,
  type CompiledToolSchema,
  type CompileRequestOptions,
  type ContextDrift,
  type ContextEstimate,
  type ContextMeter,
  type ContextRealSnapshot,
  type ContextRequestRecord,
  type ToolSchemaCategory,
} from '../../domain/context.js';
import {
  applyContextManagement,
  normalizeSummaryThreshold,
  shouldSummarizeByTokens,
  summarizeHistory,
} from '../context/summarizer.js';
import { createTokenStats } from '../stats/token-stats.js';
import { buildSystemPrompt, BuiltSystemPrompt } from '../prompt/system-prompt.js';
import { createToolPolicyGuard, type ToolRoutingPolicy } from '../chat/tool-policy.js';
import { runDecisionLoop } from '../chat/decision-loop.js';
import { writeChatDebugLog } from '../../infrastructure/persistence/chat-debug-log.js';
import {
  resolveAgentTools,
  resolveMaxToolRounds,
  resolveRepeatCallLimit,
} from './tool-resolver.js';
import { runHooks } from './hooks.js';
import {
  AgentConfigError,
  normalizeTokenPricing,
  normalizeMaxToolRounds,
  normalizeReasoning,
  normalizeServiceTier,
  resolveAgentPolicy,
  resolveRateLimitConfig,
  type ContinuationOutcome,
  type ResolvedRateLimitConfig,
  type AgentConfig,
  type Skill,
} from './config.js';
import {
  resolvePolicyDenied,
  resolvePolicyTools,
  type AgentPolicy,
} from '../../domain/agent-policy.js';

export type { AgentConfig };

const MAX_CONTEXT_RECORDS = 20;

function emptyMcpSync(): McpSyncResult {
  return { added: [], changed: [], removed: [], unchanged: [], retried: [], states: [], tools: {} };
}

function toolSchemaCategory(
  name: string,
  skillToolName: string,
  mcpToolPrefix: string = MCP_TOOL_PREFIX
): ToolSchemaCategory {
  if (name === skillToolName) return 'skills';
  if (name.startsWith(mcpToolPrefix)) return 'mcp';
  return 'tools';
}

/** `systemPrompt` is the legacy single-string field; `system` is its separate-field alias. */
function resolveSystemText(config: AgentConfig): string | undefined {
  return config.systemPrompt ?? config.system;
}

export class Agent {
  /** Sent to the provider only when configured; there is no implicit default model. */
  private model?: string;
  /** Sent to the provider only when configured; there are no implicit temperature / num_ctx values. */
  private options?: Record<string, any>;
  private config: AgentConfig;
  private provider: LLMProvider;
  private baseTools: Record<string, ToolDefinition>;
  private tools: Record<string, ToolDefinition>;
  private name: string;
  private cachedToolSchemas: any[] = [];
  private cachedToolInfo: CompiledToolSchema[] = [];
  private policyConfig: ToolRoutingPolicy;
  private policy: AgentPolicy;
  private estimator: TokenEstimator = createTokenEstimator();
  private context = createMessageContext({});
  private stats = createTokenStats();
  /** Optional price table; request records retain the price result at the moment usage arrives. */
  private tokenPricing?: TokenPricing;
  /** Usage of the most recent model request; what currently occupies the window. */
  private lastRequestUsage?: TokenUsage;
  /** Request compiled for the round in flight; paired with provider usage when it arrives. */
  private pendingRecord?: ContextRequestRecord;
  private contextRecords: ContextRequestRecord[] = [];
  private lastRealRecord?: ContextRequestRecord;
  private requestSeq = 0;
  private summarizingMidLoop = false;
  private sessionId?: string;
  private builtPrompt?: BuiltSystemPrompt;
  private chatLogSource?: string;
  private activeAbortSignal?: AbortSignal;
  /** Settings a running turn keeps even if a setter changes them meanwhile (the next turn sees the new ones). */
  private turnSnapshot?: { contextWindowTokens: number | undefined };
  private readonly toolContext: ToolContext = {};
  /** Per-instance logger (level and file from `logging`); the shared `logger` is never reconfigured by an agent. */
  private logger: Logger = createLogger();
  /** Tools merged into this agent (MCP) live here, layered over the shared registry; the shared one is never written. */
  private readonly toolRegistry: ToolRegistry = createToolRegistry(toolRegistry);
  /** Created on demand when `mcp.enabled`; never the shared `mcpClientManager`. */
  private mcpManager?: McpClientManager;
  private mcpConnected = false;
  /** Tail of the queue that runs connectMcp / syncMcp / disconnectMcp one after the other. */
  private mcpQueue: Promise<unknown> = Promise.resolve();

  constructor(config: AgentConfig) {
    // A copy: the runtime setters never write into the object the caller passed in.
    this.config = { ...config };
    this.name = config.name || 'Poyraz';
    this.model = config.model || undefined;
    this.options = config.options ? { ...config.options } : undefined;
    this.chatLogSource = config.logging?.source;
    this.policy = resolveAgentPolicy(config.policy);
    this.policyConfig = {
      maxToolRounds: resolveMaxToolRounds(config),
      repeatCallLimit: resolveRepeatCallLimit(config),
      deniedToolReason: this.policy.deniedToolReason,
      perTurnToolLimits: this.policy.perTurnToolLimits,
    };
    this.estimator = createTokenEstimator(config.tokenEstimator);
    this.tokenPricing = normalizeTokenPricing(config.tokenPricing);
    if (this.tokenPricing) this.config.tokenPricing = { ...this.tokenPricing };
    this.context = createMessageContext({
      limit: config.contextLimit,
      estimator: this.estimator,
      summaryPrefix: config.summarization?.prefix,
      skillToolName: this.skillToolName(),
    });

    if (config.provider) {
      this.provider = config.provider;
    } else {
      // Built-in providers need a model and a host; neither has an implicit default.
      if (!this.model) {
        throw new AgentConfigError(
          'No LLM provider configured: pass Provider(...), or set Model(...) together with a host (RemoteModel / LocalModel / WithModelProfile).'
        );
      }
      if (!config.host) {
        throw new AgentConfigError(
          `No host configured for model "${this.model}": set a host (RemoteModel / LocalModel / WithModelProfile) or pass Provider(...).`
        );
      }
      const profile: ModelProfile = {
        model: this.model,
        host: config.host,
        provider: inferProviderFromHost(config.host),
      };
      this.provider = createLLMProvider(profile, config.apiKey);
    }

    // Rate limit: waiting is applied only when `rateLimit.enabled`; otherwise the provider is untouched
    // and a 429 surfaces as an error at once.
    this.provider = this.applyRateLimit(this.provider);

    // MCP is optional: `config.mcp.enabled` connects its servers in `init()` / `connectMcp()`.

    this.baseTools = resolveAgentTools(config);
    this.tools = {};
    this.syncSkillTool();
    this.applyPolicy();

    // Logging is per instance: this agent's level and file never touch the shared `logger`.
    this.logger = createLogger({ level: config.logging?.level ?? config.logLevel, file: config.logging?.file });
    // Calls that log (also through the shared `logger`) run in this agent's logging scope.
    this.chat = scopeToLogger(this.logger, this.chat.bind(this));
    this.init = scopeToLogger(this.logger, this.init.bind(this));
    this.summarize = scopeToLogger(this.logger, this.summarize.bind(this));
    this.connectMcp = scopeToLogger(this.logger, this.connectMcp.bind(this));
    this.disconnectMcp = scopeToLogger(this.logger, this.disconnectMcp.bind(this));
    this.syncMcp = scopeToLogger(this.logger, this.syncMcp.bind(this));
  }

  /** Rate-limit settings after defaults; disabled (no waiting) unless `rateLimit.enabled` is true. */
  getRateLimitConfig(): ResolvedRateLimitConfig {
    return resolveRateLimitConfig(this.config.rateLimit);
  }

  /** Hands the rate-limit policy to the provider only when waiting is enabled; a disabled agent does not wrap it. */
  private applyRateLimit(provider: LLMProvider): LLMProvider {
    const policy = this.getRateLimitConfig();
    return policy.enabled && policy.maxWaits > 0 ? withRateLimitPolicy(provider, policy) : provider;
  }

  /** Name prefix of MCP-bridged tools (`mcp.toolPrefix`, default `mcp_`); it also decides the `mcp` context category. */
  getMcpToolPrefix(): string {
    return resolveMcpToolPrefix(this.config.mcp?.toolPrefix);
  }

  /** Connection states of this agent's own MCP manager (empty when MCP is off or not connected). */
  getMcpStates(): McpServerState[] {
    return this.mcpManager?.listStates() ?? [];
  }

  /**
   * Connects the servers of `config.mcp` and merges their tools into this agent. Does nothing unless
   * `mcp.enabled` is true and `mcp.servers` has entries. `init()` calls it once; call it again to reconnect.
   * The agent owns its manager (no shared singleton). A server that fails to connect is reported in the
   * returned states and logged; it does not throw.
   */
  connectMcp(): Promise<McpServerState[]> {
    return this.exclusiveMcp(() => this.connectMcpNow());
  }

  /** Runs `task` after the earlier MCP operations of this agent; a failed one does not block the next. */
  private exclusiveMcp<T>(task: () => Promise<T>): Promise<T> {
    const run = this.mcpQueue.then(task, task);
    this.mcpQueue = run.catch(() => undefined);
    return run;
  }

  private async connectMcpNow(): Promise<McpServerState[]> {
    const mcp = this.config.mcp;
    if (mcp?.enabled !== true || !mcp.servers || Object.keys(mcp.servers).length === 0) return [];
    if (!this.mcpManager) {
      const { createMcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
      this.mcpManager = createMcpClientManager({ toolPrefix: mcp.toolPrefix });
    }
    const manager = this.mcpManager;
    const tools = await manager.connectAll(mcp.servers);
    this.removeExternalTools(this.getMcpToolPrefix());
    this.mergeExternalTools(tools);
    this.mcpConnected = true;
    const states = manager.listStates();
    for (const state of states) {
      if (state.status === 'error') logger.warn('MCP server failed to connect', { server: state.id, error: state.error });
    }
    return states;
  }

  /** Removes this agent's MCP tools and closes its MCP connections. */
  disconnectMcp(): Promise<void> {
    return this.exclusiveMcp(async () => {
      this.removeExternalTools(this.getMcpToolPrefix());
      this.mcpConnected = false;
      await this.mcpManager?.disconnectAll();
    });
  }

  /**
   * Makes this agent's MCP connections match `servers` (default: `config.mcp.servers`) and touches only
   * what differs: new servers connect, servers whose definition changed reconnect, removed servers disconnect,
   * identical ones keep their connection and their tool definitions. `config.mcp.servers` becomes `servers`, so a
   * later `connectMcp()` reconnects the same list. Returns what was done per server id and the state of every
   * requested server. A failing server does not throw: its state has `status: 'error'` and it is logged.
   *
   * With `mcp.enabled` not `true` it does nothing: nothing is created, connected or changed, and the result is
   * empty. Calls run one after the other together with `connectMcp()` and `disconnectMcp()`.
   */
  syncMcp(servers?: Record<string, McpServerDef>, options?: McpSyncOptions): Promise<McpSyncResult> {
    return this.exclusiveMcp(() => this.syncMcpNow(servers, options));
  }

  private async syncMcpNow(servers?: Record<string, McpServerDef>, options?: McpSyncOptions): Promise<McpSyncResult> {
    const mcp = this.config.mcp;
    if (mcp?.enabled !== true) return emptyMcpSync();
    const wanted = { ...(servers ?? mcp.servers ?? {}) };
    this.config.mcp = { ...mcp, servers: wanted };
    if (!this.mcpManager) {
      if (Object.keys(wanted).length === 0) return emptyMcpSync();
      const { createMcpClientManager } = await import('../../infrastructure/mcp/mcp-client-manager.js');
      this.mcpManager = createMcpClientManager({ toolPrefix: mcp.toolPrefix });
    }
    const manager = this.mcpManager;
    const before = manager.getTools();
    const result = await manager.sync(wanted, options);
    // Only tools that went away or were replaced leave the agent; only new or replaced ones are merged in.
    this.dropExternalTools(Object.keys(before).filter((name) => result.tools[name] !== before[name]));
    const fresh = Object.entries(result.tools).filter(([name, tool]) => before[name] !== tool);
    if (fresh.length > 0) this.mergeExternalTools(Object.fromEntries(fresh));
    this.mcpConnected = true;
    const touched = new Set([...result.added, ...result.changed, ...result.retried]);
    for (const state of result.states) {
      if (touched.has(state.id) && state.status === 'error') {
        logger.warn('MCP server failed to connect', { server: state.id, error: state.error });
      }
    }
    return result;
  }

  private dropExternalTools(names: string[]): void {
    if (names.length === 0) return;
    const drop = new Set(names);
    const next: Record<string, ToolDefinition> = {};
    for (const [name, tool] of Object.entries(this.baseTools)) {
      if (drop.has(name)) {
        this.toolRegistry.unregister(name);
        continue;
      }
      next[name] = tool;
    }
    this.baseTools = next;
    this.applyPolicy();
  }

  private summaryEnabled(): boolean {
    return this.config.summarization?.enabled ?? this.config.autoSummary ?? false;
  }

  private summaryThresholdRatio(): number | undefined {
    return this.config.summarization?.thresholdRatio ?? this.config.summaryThresholdRatio;
  }

  /** Name the skill-loading tool goes by (default `load_skill`). */
  private skillToolName(): string {
    return this.config.skillTool?.toolName?.trim() || LOAD_SKILL_TOOL_NAME;
  }

  /** The skill catalog is reported in the prompt parts only while the skill tool is exposed. */
  private skillCatalogOptions(): { skillCatalog: boolean } {
    return { skillCatalog: Boolean(this.baseTools[this.skillToolName()]) };
  }

  /**
   * Adds or removes the skill-loading tool (default `load_skill`) from the live tool set.
   * It exists only when skills exist, the tool is not disabled (`skillTool.enabled: false`)
   * and it is not excluded.
   */
  private syncSkillTool(): void {
    const skills = normalizeSkills(this.config.skills);
    this.config.skills = skills.length > 0 ? skills : undefined;
    const toolName = this.skillToolName();
    const excluded =
      (this.config.excludeTools?.includes(toolName) ?? false) ||
      (this.config.excludeTools?.includes(LOAD_SKILL_TOOL_NAME) ?? false);
    const disabled = this.config.skillTool?.enabled === false;

    if (skills.length === 0 || excluded || disabled) {
      if (!this.baseTools[toolName]) return;
      delete this.baseTools[toolName];
      this.applyPolicy();
      return;
    }

    this.baseTools[toolName] = createLoadSkillTool(skills, toolName);
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
    const entries = Object.entries(this.tools).map(([name, tool]) => ({ name, schema: toOpenAISchema(tool) }));
    this.cachedToolSchemas = entries.map((entry) => entry.schema);
    this.cachedToolInfo = entries.map(({ name, schema }) => ({
      name,
      category: toolSchemaCategory(name, this.skillToolName(), this.getMcpToolPrefix()),
      chars: JSON.stringify(schema).length,
    }));
    this.policyConfig.deniedTools = resolvePolicyDenied(Object.keys(this.baseTools), this.policy);
    this.policyConfig.deniedToolReason = this.policy.deniedToolReason;
    this.policyConfig.perTurnToolLimits = this.policy.perTurnToolLimits;
    // A policy swapped with setPolicy brings its own `maxToolRounds` (top-level setting > policy > routingPolicy > options > 10).
    this.policyConfig.maxToolRounds = resolveMaxToolRounds({ ...this.config, policy: this.policy });
  }

  /** This agent's tool registry (layered over the shared one): where merged external tools are registered. */
  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  /**
   * Adds externally sourced tools (e.g. from connected MCP servers) to this agent's tool set.
   * Definitions are registered in this agent's own registry (`getToolRegistry()`); the shared
   * `toolRegistry` is never written. Returns the names that replaced an existing tool of this agent
   * (also logged as a warning), so a name clash is never silent.
   */
  mergeExternalTools(tools: Record<string, ToolDefinition>): string[] {
    const replaced = Object.keys(tools).filter((name) => Object.prototype.hasOwnProperty.call(this.baseTools, name));
    if (replaced.length > 0) logger.warn('External tools replaced existing tools', { tools: replaced });
    for (const tool of Object.values(tools)) {
      this.toolRegistry.register(tool);
    }
    this.baseTools = { ...this.baseTools, ...tools };
    this.applyPolicy();
    return replaced;
  }

  /** Removes previously merged external tools whose name starts with `prefix` (default: the configured MCP prefix). */
  removeExternalTools(prefix: string = this.getMcpToolPrefix()): void {
    const nextBaseTools: Record<string, ToolDefinition> = {};
    for (const [name, tool] of Object.entries(this.baseTools)) {
      if (name.startsWith(prefix)) {
        this.toolRegistry.unregister(name);
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

  /** Replaces the host rules and rebuilds the system message. */
  setRules(rules: string[] | undefined): void {
    this.config.rules = rules && rules.length > 0 ? rules : undefined;
    this.rebuildSystemPrompt();
  }

  /** Replaces the skill list; the `load_skill` tool and its catalog follow. */
  setSkills(skills: Skill[] | undefined): void {
    this.config.skills = skills;
    this.syncSkillTool();
    this.rebuildSystemPrompt();
  }

  rebuildSystemPrompt(): BuiltSystemPrompt {
    const built = buildSystemPrompt(resolveSystemText(this.config), this.config.rules, this.config.skills, this.skillCatalogOptions());
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
    if (!this.mcpConnected) await this.connectMcp();
    logger.debug('Agent initialized', { name: this.name, model: this.model });
  }

  loadHistory(messages: ChatMessage[]) {
    this.lastRealRecord = undefined;
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

  /**
   * Compiles the request for the next model call: system message, tool schemas
   * (policy-filtered, from the cached set) and history, together with its
   * per-category token estimate. `chat()` sends exactly this, so the context meter
   * and the request come from the same compilation. Does not call the provider.
   */
  compileRequest(options: CompileRequestOptions = {}): CompiledRequest {
    const built = this.builtPrompt ?? buildSystemPrompt(resolveSystemText(this.config), this.config.rules, this.config.skills, this.skillCatalogOptions());
    const includeTools = options.includeTools !== false;
    const toolSchemas = includeTools ? this.cachedToolInfo.map((info) => ({ ...info })) : [];
    const estimate = estimateRequest({
      entries: this.context.getMessageEntries(),
      toolSchemas,
      systemPrompt: built,
      estimator: this.estimator,
    });
    return {
      model: this.model ?? '',
      messages: this.context.getMessagesCopy(),
      tools: includeTools ? [...this.cachedToolSchemas] : [],
      parts: { ...built.parts },
      toolSchemas,
      estimate,
    };
  }

  /** compileRequest for a real send: remembers the estimate so provider usage can be paired with it. */
  private compileForSend(): CompiledRequest {
    const compiled = this.compileRequest();
    this.pendingRecord = {
      seq: ++this.requestSeq,
      at: Date.now(),
      model: compiled.model,
      estimate: compiled.estimate,
    };
    return compiled;
  }

  private recordUsage(usage: TokenUsage): void {
    const pending = this.pendingRecord;
    this.pendingRecord = undefined;
    if (!pending) return;
    const record = completeRecord(pending, usage, this.tokenPricing);
    this.lastRealRecord = record;
    this.contextRecords.push(record);
    if (this.contextRecords.length > MAX_CONTEXT_RECORDS) this.contextRecords.shift();
  }

  /** Local token estimate of what the next request would carry, per category. Safe to call any time. */
  estimateContext(options: CompileRequestOptions = {}): ContextEstimate {
    return this.compileRequest(options).estimate;
  }

  /**
   * Provider-reported prompt size of the last completed request, split by category
   * (estimate shares scaled to the reported `promptTokens`, so the parts add up to
   * the provider's total). `undefined` before the first request and after history
   * was replaced, summarized or trimmed. Carries the estimate and the drift.
   */
  getContextReal(): ContextRealSnapshot | undefined {
    return this.lastRealRecord ? realSnapshot(this.lastRealRecord) : undefined;
  }

  /** Estimate vs provider total of the last completed request. */
  getContextDrift(): ContextDrift | undefined {
    return this.lastRealRecord?.drift ? { ...this.lastRealRecord.drift } : undefined;
  }

  /** Recent requests (newest last, max 20) with their estimate, real usage and drift. */
  getContextRecords(): ContextRequestRecord[] {
    return this.contextRecords.map((record) => ({
      ...record,
      ...(record.real ? { real: { ...record.real } } : {}),
      ...(record.cost ? { cost: { ...record.cost } } : {}),
    }));
  }

  /** Meter from the local estimate of the current context. Needs no provider call. */
  getContextMeterEstimate(): ContextMeter {
    const estimate = this.estimateContext();
    return buildMeter('estimate', estimate.categories, estimate.total, this.config.contextWindowTokens);
  }

  /**
   * Meter from the last provider-reported usage. All zeros (total 0) until a
   * request has completed, so a UI can tell "no data yet" from a small context.
   */
  getContextMeterReal(): ContextMeter {
    const real = this.getContextReal();
    return buildMeter(
      'real',
      real?.categories ?? emptyCategoryTokens(),
      real?.total ?? 0,
      this.config.contextWindowTokens
    );
  }

  getTokenEstimator(): TokenEstimator {
    return this.estimator;
  }

  /**
   * Moves the estimator's chars/token ratio toward the last real request so later
   * estimates follow the provider's tokenizer. Returns the new ratio, or
   * `undefined` when no request has completed. Never runs on its own: the host
   * decides when drift is worth correcting.
   */
  calibrateEstimator(weight?: number): number | undefined {
    const record = this.lastRealRecord;
    if (!record?.real) return undefined;
    return this.estimator.calibrate(
      {
        chars: record.estimate.chars,
        overheadTokens: record.estimate.overheadTokens,
        realTokens: record.real.promptTokens,
      },
      weight
    );
  }

  getStats() {
    return {
      current: this.stats.getCurrent(),
      session: this.stats.getSessionTotal(),
    };
  }

  /** Current-turn and session costs from provider-reported usage, or `undefined` until prices are configured. */
  getUsageCosts(): TokenCostTotals | undefined {
    if (!this.tokenPricing) return undefined;
    return {
      current: calculateTokenCost(this.stats.getCurrent(), this.tokenPricing),
      session: calculateTokenCost(this.stats.getSessionTotal(), this.tokenPricing),
    };
  }

  getTokenPricing(): TokenPricing | undefined {
    return this.tokenPricing ? { ...this.tokenPricing } : undefined;
  }

  /** Changes the price table for future request records and aggregate cost reads. Omit to disable cost calculation. */
  setTokenPricing(pricing?: TokenPricing): void {
    this.tokenPricing = normalizeTokenPricing(pricing);
    if (this.tokenPricing) this.config.tokenPricing = { ...this.tokenPricing };
    else delete this.config.tokenPricing;
  }

  /**
   * Usage of the last model request of the current turn, or `undefined` when no
   * request has completed yet. Stays readable while a turn is aborted, so callers
   * can report what the cancelled turn actually consumed.
   */
  getContextUsage(): TokenUsage | undefined {
    return this.lastRequestUsage ? { ...this.lastRequestUsage } : undefined;
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

  setModel(model: string | undefined) {
    this.model = model;
  }

  /** `undefined` when no model or host is configured (e.g. a custom provider without a profile). */
  getModelProfile(): ModelProfile | undefined {
    const host = this.config.host;
    if (!this.model || !host) return undefined;
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
    this.provider = this.applyRateLimit(createLLMProvider(profile, apiKey));
  }

  setSessionId(id: string) {
    this.sessionId = id;
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Free-text origin tag for chat debug logs (only written when `logging.chatDebugLog` is on). */
  setChatLogSource(source: string) {
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

  // --- Runtime settings: take effect from the next turn; a running turn keeps the values it started with ---

  getReasoning(): ReasoningConfig | undefined {
    return this.config.reasoning ? { ...this.config.reasoning } : undefined;
  }

  /** `{ effort }` for the next turns; `undefined` (or no effort) clears it. An unknown effort throws `AgentConfigError`. */
  setReasoning(config?: ReasoningConfig): void {
    const reasoning = normalizeReasoning(config);
    if (reasoning) this.config.reasoning = reasoning;
    else delete this.config.reasoning;
  }

  getServiceTier(): ServiceTier | undefined {
    return this.config.serviceTier;
  }

  /** Service tier for the next turns; `undefined` clears it. An unknown tier throws `AgentConfigError`. */
  setServiceTier(tier?: ServiceTier): void {
    const next = normalizeServiceTier(tier);
    if (next) this.config.serviceTier = next;
    else delete this.config.serviceTier;
  }

  getContextWindow(): number | undefined {
    return this.config.contextWindowTokens;
  }

  /**
   * Token window for the meter and for token-based summarization; `undefined` clears it (no token
   * pressure, no percentage). Rounded down; a value `ContextWindow(...)` would ignore (non-finite or
   * below 1000) throws `AgentConfigError`. A turn in progress keeps the window it started with.
   */
  setContextWindow(tokens?: number): void {
    if (tokens === undefined) {
      delete this.config.contextWindowTokens;
      return;
    }
    const window = normalizeContextWindow(tokens);
    if (window === undefined) {
      throw new AgentConfigError(
        `Invalid context window: ${String(tokens)} (expected a finite number of at least ${MIN_CONTEXT_WINDOW_TOKENS})`
      );
    }
    this.config.contextWindowTokens = window;
  }

  /** The tool round budget a new turn gets (default 10). */
  getMaxToolRounds(): number {
    return this.policyConfig.maxToolRounds;
  }

  /**
   * Tool round budget per turn. `undefined` clears the top-level value, so the budget falls back to
   * `policy.maxToolRounds`, `routingPolicy`, `options.max_tool_rounds`, then 10. Rounded down; a non-positive or
   * non-finite value throws `AgentConfigError`.
   */
  setMaxToolRounds(rounds?: number): void {
    if (rounds === undefined) {
      delete this.config.maxToolRounds;
    } else {
      const next = normalizeMaxToolRounds(rounds);
      if (next === undefined) {
        throw new AgentConfigError(`Invalid max tool rounds: ${String(rounds)} (expected a positive finite number)`);
      }
      this.config.maxToolRounds = next;
    }
    this.policyConfig.maxToolRounds = resolveMaxToolRounds({ ...this.config, policy: this.policy });
  }

  getMessageHistory(): ChatMessage[] {
    return this.context.getMessagesCopy();
  }

  getPromptCacheKey(): string | undefined {
    // No system content (a bare agent) means nothing worth caching: send no key.
    if (!this.builtPrompt?.content.trim()) return undefined;
    return `${this.name}:${this.builtPrompt.cacheKey}`;
  }

  /** Compact older turns into a single rolling user summary message. */
  async summarize(handlers?: ChatHandlers): Promise<void> {
    if (this.config.hooks?.PreCompact?.length) {
      const compact = await runHooks(this.config.hooks, {
        hook_event_name: 'PreCompact',
        session_id: this.sessionId,
      }, { signal: this.activeAbortSignal });
      if (compact.blocked) return;
    }
    const summarization = this.config.summarization;
    await summarizeHistory(this.context, this.provider, this.model, handlers, this.config.serviceTier, {
      prompt: summarization?.prompt,
      prefix: summarization?.prefix,
      keepRatio: summarization?.keepRatio,
      toolResultMaxChars: summarization?.toolResultMaxChars,
      onSummarized: summarization?.onSummarized
        ? (summarized) => summarization.onSummarized!({ ...summarized, sessionId: this.sessionId })
        : undefined,
      onUsage: (usage) => this.recordExternalUsage(usage),
    });
    if (this.config.hooks?.PostCompact?.length) {
      await runHooks(this.config.hooks, {
        hook_event_name: 'PostCompact',
        session_id: this.sessionId,
      }, { signal: this.activeAbortSignal });
    }
    // The last real request described the history from before the summary.
    this.lastRealRecord = undefined;
  }

  private tokenPressureNow(): boolean {
    const lastUsage = this.lastRequestUsage;
    const promptTokens = lastUsage ? lastUsage.promptTokens : undefined;
    return shouldSummarizeByTokens({
      promptTokens,
      contextWindowTokens: this.contextWindowForDecision(),
      summaryThresholdRatio: normalizeSummaryThreshold(this.summaryThresholdRatio()),
    });
  }

  /** The window summarization decisions use: the one a running turn started with, else the current one. */
  private contextWindowForDecision(): number | undefined {
    return this.turnSnapshot ? this.turnSnapshot.contextWindowTokens : this.config.contextWindowTokens;
  }

  /**
   * Token pressure check between tool rounds. Skips while a tool_calls pair is
   * open (cutting there orphans tool_call_ids and the provider 400s) and while
   * a summary is already running (the summary request itself must not recurse).
   */
  private async maybeSummarizeMidLoop(handlers?: ChatHandlers): Promise<void> {
    if (!this.summaryEnabled()) return;
    if (this.summarizingMidLoop) return;
    if (!this.tokenPressureNow()) return;
    const messages = this.context.getMessages();
    const last = messages.length > 0 ? messages[messages.length - 1] : undefined;
    if (last?.role === 'assistant' && Array.isArray(last.tool_calls) && last.tool_calls.length > 0) return;
    this.summarizingMidLoop = true;
    try {
      await this.summarize(handlers);
      this.lastRequestUsage = undefined;
    } finally {
      this.summarizingMidLoop = false;
    }
  }

  async chat(
    userInput: string,
    handlers?: ChatHandlers
  ): Promise<{
    content: string;
    usage: TokenUsage;
    contextUsage?: TokenUsage;
    /** Set when a `ContinuationPolicy` is configured: how many times it continued, and why it stopped. */
    continuation?: ContinuationOutcome;
  }> {
    this.context.addMessage({ role: 'user', content: userInput, ...(handlers?.images?.length ? { images: handlers.images.map((image) => ({ ...image })) } : {}) });
    this.stats.resetCurrent();
    this.lastRequestUsage = undefined;
    this.activeAbortSignal = handlers?.signal;
    this.turnSnapshot = { contextWindowTokens: this.config.contextWindowTokens };

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
          policy: { ...this.policyConfig },
          promptCacheKey: this.getPromptCacheKey(),
          promptCacheRetention: this.config.promptCacheRetention,
          reasoning: this.config.reasoning,
          serviceTier: this.config.serviceTier,
          agentPolicy: this.policy,
          repair: this.config.repair,
          sameToolBreaker: this.config.sameToolBreaker,
          progressTools: this.config.progressTools,
          continuation: this.config.continuation,
          toolResultLimit: { maxChars: this.config.toolResultMaxChars, maxBytes: this.config.toolResultMaxBytes },
          hooks: this.config.hooks,
        },
        this.tools,
        policyGuard,
        {
          getMessages: () => this.context.getMessages(),
          addMessage: (message) => this.context.addMessage(message),
          compileRequest: () => this.compileForSend(),
          onEvent: handlers?.onEvent,
          onUsage: (usage) => {
            this.lastRequestUsage = usage;
            this.stats.addUsage(usage);
            this.recordUsage(usage);
          },
          buildToolContext: () => this.buildToolContext(),
          beforeRound: () => this.maybeSummarizeMidLoop(handlers),
          getPromptCacheKey: () => this.getPromptCacheKey(),
          getSessionId: () => this.sessionId,
          signal: handlers?.signal,
        }
      );

      const historyBeforeManagement = this.context.getMessages();
      await applyContextManagement(
        this.context,
        this.summaryEnabled(),
        handlers,
        () => this.summarize(handlers),
        {
          promptTokens: this.getContextUsage()?.promptTokens,
          contextWindowTokens: this.contextWindowForDecision(),
          summaryThresholdRatio: normalizeSummaryThreshold(this.summaryThresholdRatio()),
        }
      );

      // trim/summarize swap the history array; the last real request no longer matches it.
      if (this.context.getMessages() !== historyBeforeManagement) this.lastRealRecord = undefined;

      result = { content: loopResult.content, usage: this.stats.getCurrent() };
      if (!handlers?.signal?.aborted && this.config.hooks?.Stop?.length) {
        await runHooks(this.config.hooks, {
          hook_event_name: 'Stop',
          session_id: this.sessionId,
        }, { signal: handlers?.signal });
      }
      // Billing includes every tool round; context occupancy is the last request only.
      return {
        ...result,
        contextUsage: loopResult.usage,
        ...(loopResult.continuation ? { continuation: loopResult.continuation } : {}),
      };
    } catch (error: any) {
      chatError = error.message;
      logger.error('Chat error', { error: error.message });
      throw error;
    } finally {
      this.activeAbortSignal = undefined;
      this.turnSnapshot = undefined;
      if (this.config.logging?.chatDebugLog) {
        void writeChatDebugLog({
          timestamp: new Date().toISOString(),
          source: this.chatLogSource,
          sessionId: this.sessionId,
          agentName: this.name,
          model: this.model ?? '',
          userInput,
          systemPrompt: this.builtPrompt?.content ?? null,
          messages: this.context.getMessagesCopy(),
          usage: result?.usage ?? this.stats.getCurrent(),
          error: chatError,
        }, this.logger.getLogDir() ?? undefined);
      }
    }
  }

  private buildToolContext(): ToolContext {
    this.toolContext.agent = this;
    this.toolContext.logger = this.logger;
    this.toolContext.sessionId = this.sessionId;
    this.toolContext.abortSignal = this.activeAbortSignal;
    return this.toolContext;
  }
}
