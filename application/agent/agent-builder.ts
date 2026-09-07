import { Agent } from './agent.js';
import type { AgentConfig, AgentTemplate } from './config.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import { ToolDefinition } from '../../tools/index.js';
import { toolRegistry, ToolPresetName, TOOL_PRESETS } from '../../tools/core/registry.js';
import { LogLevel } from '../../shared/logger.js';
import type { LLMProvider } from '../../domain/llm.js';
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

  AutoSummary(enabled: boolean = true): this {
    this.config.autoSummary = enabled;
    return this;
  }

  RemoteContext(url: string): this {
    this.config.remoteContextUrl = url;
    return this;
  }

  Identity(identity: string): this {
    this.config.identity = identity;
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
    if (json.remoteContextUrl) this.RemoteContext(json.remoteContextUrl);
    if (json.identity) this.Identity(json.identity);
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
      this.config.toolPresets = Object.keys(TOOL_PRESETS) as ToolPresetName[];
    }

    this.toolsFinalized = true;
  }

  Build(): Agent {
    this.finalizeTools();
    return new Agent(this.config);
  }
}
