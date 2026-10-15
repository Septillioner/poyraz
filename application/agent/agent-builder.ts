import { Agent } from './agent.js';
import {
  type AgentConfig,
  type AgentMcpConfig,
  chainContinuation,
  normalizeReasoning,
  normalizeServiceTier,
  type AgentTemplate,
  type ContinuationPolicy,
  type LoggingConfig,
  type PolicyConfig,
  type RateLimitConfig,
  type RepairConfig,
  type SameToolBreakerConfig,
  type Skill,
  type SkillToolConfig,
  type OnSummarizedHook,
  type SummarizationConfig,
} from './config.js';
import { normalizeSkills } from '../../tools/definitions/skills.js';
import type { ErrorBreakerMode, ResponseGate } from '../../domain/agent-policy.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { DEFAULT_OLLAMA_HOST } from '../../domain/model-profile.js';
import { ToolDefinition } from '../../tools/index.js';
import { createToolRegistry, toolRegistry, ToolPresetName } from '../../tools/core/registry.js';
import { LogLevel, type FileLoggingConfig } from '../../shared/logger.js';
import type { LLMProvider, ReasoningConfig, ServiceTier } from '../../domain/llm.js';
import type { ToolRoutingPolicy } from '../chat/tool-policy.js';
import type { TokenEstimatorOptions } from '../context/token-estimate.js';
import { normalizeSummaryThreshold } from '../context/summary-settings.js';

import { MIN_CONTEXT_WINDOW_TOKENS, normalizeContextWindow } from '../context/context-window.js';

export { MIN_CONTEXT_WINDOW_TOKENS };

/**
 * `repair` from JSON: booleans and plain settings are read as they are; `resolvers` and `generic`
 * carry functions, so only function values are accepted (anything else is dropped).
 */
function repairFromJson(value: unknown): RepairConfig | boolean {
  if (typeof value === 'boolean') return value;
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  const repair: RepairConfig = {};
  if (typeof source.enabled === 'boolean') repair.enabled = source.enabled;
  if (typeof source.maxAttempts === 'number') repair.maxAttempts = source.maxAttempts;
  if (typeof source.generic === 'function') repair.generic = source.generic as RepairConfig['generic'];
  if (source.resolvers && typeof source.resolvers === 'object') {
    const resolvers = Object.fromEntries(
      Object.entries(source.resolvers as Record<string, unknown>).filter(([, fn]) => typeof fn === 'function')
    ) as NonNullable<RepairConfig['resolvers']>;
    if (Object.keys(resolvers).length > 0) repair.resolvers = resolvers;
  }
  return repair;
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Builds an agent. A bare `new AgentBuilder().Provider(p).Build()` is a plain text
 * completion: no system message, rules, skills, tools or summary, no logging, no
 * rate-limit waiting, and no model/host/options sent unless you set them.
 * Every feature is opt-in through the methods below.
 */
export class AgentBuilder {
  private config: AgentConfig = {};

  /**
   * Per-builder registry layered over the shared one (read-only fallback for built-in
   * names/presets). `RegisterTool` writes here, never to the shared `toolRegistry`.
   */
  private readonly registry = createToolRegistry(toolRegistry);

  private explicitTools: Record<string, ToolDefinition> = {};
  private toolPresets: ToolPresetName[] = [];
  private includeTools: string[] = [];
  private excludeTools: string[] = [];

  // --- Model / provider ------------------------------------------------------

  Model(model: string): this {
    this.config.model = model;
    return this;
  }

  Name(name: string): this {
    this.config.name = name;
    return this;
  }

  LocalModel(model: string): this {
    this.config.model = model;
    this.config.host = DEFAULT_OLLAMA_HOST;
    return this;
  }

  RemoteModel(url: string, model?: string): this {
    this.config.host = url;
    if (model) this.config.model = model;
    return this;
  }

  Provider(provider: LLMProvider): this {
    this.config.provider = provider;
    return this;
  }

  WithModelProfile(profile: ModelProfile): this {
    this.config.model = profile.model;
    this.config.host = profile.host;
    return this;
  }

  ApiKey(key: string): this {
    this.config.apiKey = key;
    return this;
  }

  /** Provider options (`temperature`, `num_ctx`, ...). Nothing is sent unless you call this. */
  Options(options: Record<string, any>): this {
    this.config.options = { ...this.config.options, ...options };
    return this;
  }

  Reasoning(config: ReasoningConfig): this {
    this.config.reasoning = normalizeReasoning(config);
    return this;
  }

  ServiceTier(tier?: ServiceTier): this {
    this.config.serviceTier = normalizeServiceTier(tier);
    return this;
  }

  PromptCacheRetention(retention?: 'in_memory' | '24h'): this {
    if (retention !== undefined && retention !== 'in_memory' && retention !== '24h') {
      throw new Error(`Unknown prompt cache retention: ${String(retention)}`);
    }
    this.config.promptCacheRetention = retention;
    return this;
  }

  // --- Tools (none unless selected) ------------------------------------------

  WithPresets(...presets: ToolPresetName[]): this {
    this.toolPresets.push(...presets);
    return this;
  }

  WithTools(...names: string[]): this {
    this.includeTools.push(...names);
    return this;
  }

  WithoutTools(...names: string[]): this {
    this.excludeTools.push(...names);
    return this;
  }

  /** Adds the tool to this agent and to this builder's own registry. The shared `toolRegistry` is not touched. */
  RegisterTool(definition: ToolDefinition): this {
    this.registry.register(definition);
    this.explicitTools[definition.name] = definition;
    return this;
  }

  DefaultSystemTools(
    permissions: {
      read?: boolean;
      write?: boolean;
      execute?: boolean;
      search?: boolean;
      grep?: boolean;
    } = { read: true, write: true, execute: true, grep: true }
  ): this {
    const presets: ToolPresetName[] = [];
    if (permissions.read || permissions.write) presets.push('filesystem');
    if (permissions.execute) presets.push('shell');
    if (permissions.grep || permissions.search) presets.push('search');
    const selected = this.registry.resolveToolSet({ presets });
    this.explicitTools = { ...this.explicitTools, ...selected };
    return this;
  }

  AddTool(name: string, definition: ToolDefinition): this {
    this.explicitTools[name] = definition;
    return this;
  }

  AddTools(tools: Record<string, ToolDefinition>): this {
    this.explicitTools = { ...this.explicitTools, ...tools };
    return this;
  }

  // --- System / rules / skills -----------------------------------------------

  /** Full system message text. Empty/omitted and no rules -> no system message. */
  SystemPrompt(text: string): this {
    this.config.systemPrompt = text;
    return this;
  }

  /** Alias field of `SystemPrompt` (`SystemPrompt` wins when both are set). */
  System(text: string): this {
    this.config.system = text;
    return this;
  }

  Rules(...texts: string[]): this {
    const rules = texts.map((text) => text.trim()).filter((text) => text.length > 0);
    this.config.rules = rules.length > 0 ? rules : undefined;
    return this;
  }

  AddSkill(skill: Skill): this {
    const [normalized] = normalizeSkills([skill]);
    if (!normalized) {
      throw new Error('Skill requires name, description, and content');
    }
    const skills = [...(this.config.skills ?? [])];
    const index = skills.findIndex((item) => item.name === normalized.name);
    if (index >= 0) skills[index] = normalized;
    else skills.push(normalized);
    this.config.skills = skills;
    return this;
  }

  AddSkills(skills: Skill[]): this {
    for (const skill of skills) this.AddSkill(skill);
    return this;
  }

  /** Skill-loading tool: on/off and the name shown to the model (default `load_skill`). */
  SkillTool(config: SkillToolConfig | boolean): this {
    this.config.skillTool = typeof config === 'boolean' ? { enabled: config } : { ...config };
    return this;
  }

  // --- Context / summarization -----------------------------------------------

  ContextLimit(limit: number): this {
    this.config.contextLimit = limit;
    return this;
  }

  ContextWindow(tokens: number): this {
    const window = normalizeContextWindow(tokens);
    if (window !== undefined) this.config.contextWindowTokens = window;
    return this;
  }

  /** Tunes the local token estimator behind the context meter (chars per token, per-message overhead). */
  TokenEstimator(options: TokenEstimatorOptions): this {
    this.config.tokenEstimator = { ...options };
    return this;
  }

  /** Shortcut for `Summarization({ enabled })`. Off by default. */
  AutoSummary(enabled: boolean = true): this {
    this.config.autoSummary = enabled;
    return this;
  }

  /** Shortcut for `Summarization({ thresholdRatio })`. Clamped to 0.5..0.95. */
  AutoSummaryThreshold(ratio: number): this {
    if (typeof ratio === 'number' && Number.isFinite(ratio)) {
      this.config.summaryThresholdRatio = normalizeSummaryThreshold(ratio);
    }
    return this;
  }

  /** Summarization section: enabled, threshold/keep ratios, prompt and prefix. `true`/`false` toggles only. */
  Summarization(config: SummarizationConfig | boolean): this {
    this.config.summarization = typeof config === 'boolean' ? { enabled: config } : { ...config };
    return this;
  }

  /**
   * Post-summary hook (`summarization.onSummarized`): runs after each summary and may return text
   * to append to the summary message. Does not enable summarization; `OnSummarized()` clears it.
   * Calling `Summarization(...)` afterwards replaces the whole section, hook included.
   */
  OnSummarized(hook?: OnSummarizedHook): this {
    const { onSummarized: _previous, ...rest } = this.config.summarization ?? {};
    this.config.summarization = hook ? { ...rest, onSummarized: hook } : Object.keys(rest).length > 0 ? rest : undefined;
    return this;
  }

  // --- Tool loop / routing ---------------------------------------------------

  RoutingPolicy(policy: Partial<ToolRoutingPolicy>): this {
    // `deterministicMode` was a dead flag (nothing read it); old templates may still carry it.
    const { deterministicMode: _legacy, ...rest } = policy as Partial<ToolRoutingPolicy> & {
      deterministicMode?: unknown;
    };
    this.config.routingPolicy = { ...(this.config.routingPolicy || {}), ...rest };
    return this;
  }

  /** Tool round budget per turn. */
  MaxToolRounds(rounds: number): this {
    if (isPositiveNumber(rounds)) this.config.maxToolRounds = Math.floor(rounds);
    return this;
  }

  /** Limit for identical tool+args calls within a turn. */
  RepeatCallLimit(limit: number): this {
    if (isPositiveNumber(limit)) this.config.repeatCallLimit = Math.floor(limit);
    return this;
  }

  /** Repair instructions on failed tool results. Off by default. */
  Repair(config: RepairConfig | boolean = true): this {
    this.config.repair =
      typeof config === 'boolean'
        ? { enabled: config }
        : { ...config, resolvers: config.resolvers ? { ...config.resolvers } : undefined };
    return this;
  }

  /** Same-tool loop breaker. Off by default. */
  SameToolBreaker(config: SameToolBreakerConfig | boolean = true): this {
    this.config.sameToolBreaker = typeof config === 'boolean' ? { enabled: config } : { ...config };
    return this;
  }

  /** Tool names whose success counts as progress for the same-tool breaker. Default: none. */
  ProgressTools(...names: string[]): this {
    this.config.progressTools = names.filter((name) => name.trim().length > 0);
    return this;
  }

  /** Longest tool result in characters. A longer result is cut and ends with a `[truncated: ...]` note. Default: no limit. */
  ToolResultMaxChars(chars: number): this {
    if (isPositiveNumber(chars)) this.config.toolResultMaxChars = Math.floor(chars);
    return this;
  }

  /** Longest tool result in UTF-8 bytes. Same cut and note. Default: no limit. */
  ToolResultMaxBytes(bytes: number): this {
    if (isPositiveNumber(bytes)) this.config.toolResultMaxBytes = Math.floor(bytes);
    return this;
  }

  /**
   * Plugs host-defined continuation rules. Several policies are chained (first `continue` wins,
   * see `chainContinuation`). Calling it again replaces the previous ones. Default: none.
   */
  Continuation(...policies: ContinuationPolicy[]): this {
    this.config.continuation = policies.length > 0 ? chainContinuation(...policies) : undefined;
    return this;
  }

  // --- Policy ----------------------------------------------------------------

  /** Replaces the whole policy section. Every field is optional; omitted fields are off / permissive. */
  Policy(policy: PolicyConfig): this {
    this.config.policy = { ...policy };
    return this;
  }

  AllowedTools(tools: 'all' | string[]): this {
    this.config.policy = { ...(this.config.policy ?? {}), allowedTools: tools === 'all' ? 'all' : [...tools] };
    return this;
  }

  /** Tools that are never available (names or `*` patterns); deny wins over `AllowedTools`. Same as `Policy({ deniedTools })` on top of the current policy. */
  DeniedTools(...names: string[]): this {
    this.config.policy = { ...(this.config.policy ?? {}), deniedTools: [...names] };
    return this;
  }

  ErrorBreaker(mode: ErrorBreakerMode): this {
    this.config.policy = { ...(this.config.policy ?? {}), errorBreaker: mode };
    return this;
  }

  ResponseGates(...gates: ResponseGate[]): this {
    this.config.policy = { ...(this.config.policy ?? {}), responseGates: gates };
    return this;
  }

  PerTurnToolLimits(limits: Record<string, number>): this {
    this.config.policy = { ...(this.config.policy ?? {}), perTurnToolLimits: { ...limits } };
    return this;
  }

  // --- MCP / rate limit / logging --------------------------------------------

  /** Optional MCP section. Off unless `enabled: true`. */
  Mcp(config: AgentMcpConfig | boolean): this {
    this.config.mcp = typeof config === 'boolean' ? { enabled: config } : { ...config };
    return this;
  }

  /** Wait-and-retry on rate limits. Off by default; when enabled the wait budget is finite. */
  RateLimit(config: RateLimitConfig | boolean = true): this {
    this.config.rateLimit = typeof config === 'boolean' ? { enabled: config } : { ...config };
    return this;
  }

  /** Logging section: level, file logging, chat debug log, source tag. Everything is off by default. */
  Logging(config: LoggingConfig): this {
    this.config.logging = { ...config, file: config.file ? { ...config.file } : undefined };
    return this;
  }

  LogLevel(level: LogLevel): this {
    this.config.logLevel = level;
    return this;
  }

  /** Shortcut for `Logging({ file })`. */
  FileLogging(config: FileLoggingConfig): this {
    this.config.logging = { ...(this.config.logging ?? {}), file: { ...config } };
    return this;
  }

  /** One JSON file per chat turn in the configured log dir (needs file logging). Off by default. */
  ChatDebugLog(enabled: boolean = true): this {
    this.config.logging = { ...(this.config.logging ?? {}), chatDebugLog: enabled };
    return this;
  }

  /** Free-text origin tag stored in chat debug logs. */
  LogSource(source: string): this {
    this.config.logging = { ...(this.config.logging ?? {}), source };
    return this;
  }

  // --- JSON ------------------------------------------------------------------

  FromTemplate(template: AgentTemplate): this {
    if (template.name) this.Name(template.name);
    return this.FromJSON(template);
  }

  FromJSON(json: any): this {
    if (json.name) this.Name(json.name);
    if (json.localModel) this.LocalModel(json.localModel);
    if (json.remoteModel) {
      if (typeof json.remoteModel === 'string') {
        this.RemoteModel(json.remoteModel);
      } else {
        this.RemoteModel(json.remoteModel.url, json.remoteModel.model);
      }
    }
    if (json.model && !json.localModel) this.Model(json.model);
    if (json.host && !json.localModel) this.RemoteModel(json.host);

    if (json.toolPresets?.length) {
      this.WithPresets(...json.toolPresets);
    } else if (json.defaultTools) {
      this.DefaultSystemTools(json.defaultTools);
    }

    if (json.includeTools?.length) this.WithTools(...json.includeTools);
    if (json.excludeTools?.length) this.WithoutTools(...json.excludeTools);

    if (json.contextLimit) this.ContextLimit(json.contextLimit);
    if (json.contextWindowTokens) this.ContextWindow(json.contextWindowTokens);
    if (json.summaryThresholdRatio !== undefined) this.AutoSummaryThreshold(json.summaryThresholdRatio);
    if (json.autoSummary !== undefined) this.AutoSummary(json.autoSummary);
    if (json.summarization !== undefined) this.Summarization(json.summarization);
    if (json.tokenEstimator) this.TokenEstimator(json.tokenEstimator);
    if (json.reasoning) this.Reasoning(json.reasoning);
    if (json.serviceTier) this.ServiceTier(json.serviceTier);
    if (json.systemPrompt) this.SystemPrompt(json.systemPrompt);
    if (json.system) this.System(json.system);
    if (json.rules?.length) this.Rules(...json.rules);
    if (json.skills?.length) this.AddSkills(json.skills);
    if (json.skillTool !== undefined) this.SkillTool(json.skillTool);
    if (json.promptCacheRetention) this.PromptCacheRetention(json.promptCacheRetention);
    if (json.options) this.Options(json.options);
    if (json.routingPolicy) this.RoutingPolicy(json.routingPolicy);
    if (json.maxToolRounds !== undefined) this.MaxToolRounds(json.maxToolRounds);
    if (json.repeatCallLimit !== undefined) this.RepeatCallLimit(json.repeatCallLimit);
    if (json.repair !== undefined) this.Repair(repairFromJson(json.repair));
    if (json.sameToolBreaker !== undefined) this.SameToolBreaker(json.sameToolBreaker);
    if (json.progressTools?.length) this.ProgressTools(...json.progressTools);
    if (json.toolResultMaxChars !== undefined) this.ToolResultMaxChars(json.toolResultMaxChars);
    if (json.toolResultMaxBytes !== undefined) this.ToolResultMaxBytes(json.toolResultMaxBytes);
    if (json.policy) this.Policy(json.policy);
    if (json.continuation && typeof json.continuation.evaluate === 'function') {
      this.Continuation(json.continuation);
    } else if (Array.isArray(json.continuation)) {
      this.Continuation(...json.continuation.filter((p: any) => typeof p?.evaluate === 'function'));
    }
    if (json.mcp !== undefined) this.Mcp(json.mcp);
    if (json.rateLimit !== undefined) this.RateLimit(json.rateLimit);
    if (json.logging) this.Logging(json.logging);
    if (json.logLevel) this.LogLevel(json.logLevel as LogLevel);
    if (json.apiKey) this.ApiKey(json.apiKey);
    return this;
  }

  // --- Build -----------------------------------------------------------------

  /**
   * Presets/include names are looked up in this builder's registry (own tools first, then the
   * built-ins of the shared one). Explicit tools win by name. No selection and no explicit
   * tools means a bare agent with no tools.
   */
  private resolveTools(): Record<string, ToolDefinition> {
    const hasSelection = this.toolPresets.length > 0 || this.includeTools.length > 0;
    const selected = hasSelection
      ? this.registry.resolveToolSet({
          presets: this.toolPresets.length ? this.toolPresets : undefined,
          include: this.includeTools,
          exclude: this.excludeTools,
        })
      : {};
    return { ...selected, ...this.explicitTools };
  }

  /** Throws `AgentConfigError` when neither a provider nor a model + host was given. */
  Build(): Agent {
    const config: AgentConfig = { ...this.config, tools: this.resolveTools() };
    if (this.excludeTools.length > 0) config.excludeTools = [...this.excludeTools];
    return new Agent(config);
  }
}
