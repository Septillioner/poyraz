import { Agent } from './agent.js';
import type { AgentConfig, AgentDelegationConfig, AgentTemplate, Skill } from './config.js';
import { normalizeSkills } from '../../tools/definitions/skills.js';
import type { AgentPolicy } from '../../domain/agent-policy.js';
import type { TodoStore } from '../../domain/todo-store.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { ToolDefinition } from '../../tools/index.js';
import { toolRegistry, ToolPresetName } from '../../tools/core/registry.js';
import { LogLevel } from '../../shared/logger.js';
import { isReasoningEffort, type LLMProvider, type ReasoningConfig } from '../../domain/llm.js';
import type { ToolRoutingPolicy } from '../chat/tool-policy.js';

function defaultToolsFromPermissions(permissions: {
  read?: boolean;
  write?: boolean;
  execute?: boolean;
  tasks?: boolean;
  search?: boolean;
  grep?: boolean;
}): Record<string, ToolDefinition> {
  const presets: ToolPresetName[] = [];
  if (permissions.read || permissions.write) presets.push('filesystem');
  if (permissions.execute) presets.push('shell');
  if (permissions.tasks) presets.push('planning');
  if (permissions.grep || permissions.search) presets.push('search');
  return toolRegistry.resolveToolSet({ presets });
}

export class AgentBuilder {
  private config: AgentConfig = {
    tools: {},
  };

  private explicitTools: Record<string, ToolDefinition> = {};
  private toolPresets: ToolPresetName[] = [];
  private includeTools: string[] = [];
  private excludeTools: string[] = [];
  private toolsFinalized = false;

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
    this.config.host = 'http://127.0.0.1:11434';
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

  RegisterTool(definition: ToolDefinition): this {
    this.explicitTools[definition.name] = definition;
    toolRegistry.register(definition);
    return this;
  }

  DefaultSystemTools(
    permissions: {
      read?: boolean;
      write?: boolean;
      execute?: boolean;
      tasks?: boolean;
      search?: boolean;
      grep?: boolean;
    } = { read: true, write: true, execute: true, tasks: true, grep: true }
  ): this {
    const selected = defaultToolsFromPermissions(permissions);
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

  ContextLimit(limit: number): this {
    this.config.contextLimit = limit;
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

  AutoSummary(enabled: boolean = true): this {
    this.config.autoSummary = enabled;
    return this;
  }

  Reasoning(config: ReasoningConfig): this {
    if (config.effort !== undefined && !isReasoningEffort(config.effort)) {
      throw new Error(`Unknown reasoning effort: ${String(config.effort)}`);
    }
    this.config.reasoning = config.effort ? { effort: config.effort } : undefined;
    return this;
  }

  RemoteContext(url: string): this {
    this.config.remoteContextUrl = url;
    return this;
  }

  SystemPrompt(text: string): this {
    this.config.systemPrompt = text;
    return this;
  }

  Options(options: Record<string, any>): this {
    this.config.options = { ...this.config.options, ...options };
    return this;
  }

  RoutingPolicy(policy: Partial<ToolRoutingPolicy>): this {
    this.config.routingPolicy = { ...(this.config.routingPolicy || {}), ...policy };
    return this;
  }

  LogLevel(level: LogLevel): this {
    this.config.logLevel = level;
    return this;
  }

  FromTemplate(template: AgentTemplate): this {
    if (template.name) this.Name(template.name);
    return this.FromJSON(template);
  }

  WithModelProfile(profile: ModelProfile): this {
    this.config.model = profile.model;
    this.config.host = profile.host;
    return this;
  }

  FromJSON(json: any): this {
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
    if (json.autoSummary !== undefined) this.AutoSummary(json.autoSummary);
    if (json.reasoning) this.Reasoning(json.reasoning);
    if (json.remoteContextUrl) this.RemoteContext(json.remoteContextUrl);
    if (json.systemPrompt) this.SystemPrompt(json.systemPrompt);
    if (json.rules?.length) this.Rules(...json.rules);
    if (json.skills?.length) this.AddSkills(json.skills);
    if (json.promptCacheRetention) this.config.promptCacheRetention = json.promptCacheRetention;
    if (json.options) this.Options(json.options);
    if (json.routingPolicy) this.RoutingPolicy(json.routingPolicy);
    if (json.logLevel) this.LogLevel(json.logLevel as LogLevel);
    if (json.apiKey) this.ApiKey(json.apiKey);
    return this;
  }

  ApiKey(key: string): this {
    this.config.apiKey = key;
    return this;
  }

  TodoStore(store: TodoStore): this {
    this.config.todoStore = store;
    return this;
  }

  Policy(policy: AgentPolicy): this {
    this.config.policy = policy;
    return this;
  }

  Delegation(delegation: AgentDelegationConfig | null): this {
    this.config.delegation = delegation ?? undefined;
    return this;
  }

  private finalizeTools() {
    if (this.toolsFinalized) return;

    const hasExplicit = Object.keys(this.explicitTools).length > 0;
    const hasSelection =
      this.toolPresets.length > 0 || this.includeTools.length > 0 || this.excludeTools.length > 0;

    if (hasExplicit && hasSelection) {
      const resolved = toolRegistry.resolveToolSet({
        presets: this.toolPresets.length ? this.toolPresets : undefined,
        include: this.includeTools,
        exclude: this.excludeTools,
      });
      this.config.tools = { ...resolved, ...this.explicitTools };
    } else if (hasExplicit) {
      this.config.tools = { ...this.explicitTools };
    } else if (hasSelection) {
      this.config.tools = toolRegistry.resolveToolSet({
        presets: this.toolPresets.length ? this.toolPresets : undefined,
        include: this.includeTools,
        exclude: this.excludeTools,
      });
    } else {
      this.config.tools = {};
    }

    this.toolsFinalized = true;
  }

  Build(): Agent {
    this.finalizeTools();
    return new Agent(this.config);
  }
}
