import type { LLMProvider } from '../../domain/llm.js';
import type { AgentPolicy } from '../../domain/agent-policy.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import type { TodoStore } from '../../domain/todo-store.js';
import type { ToolPresetName } from '../../tools/core/registry.js';
import type { LogLevel } from '../../shared/logger.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { ToolRoutingPolicy } from '../chat/tool-policy.js';

export type { ToolRoutingPolicy };

export interface AgentDelegationConfig {
  modelProfile: ModelProfile;
  apiKey: string;
}

export interface AgentConfig {
  model?: string;
  host?: string;
  /** Full system message content. Empty/omitted → no system message. */
  systemPrompt?: string;
  workflow?: string;
  rules?: string[];
  tools?: Record<string, ToolDefinition>;
  toolPresets?: ToolPresetName[];
  includeTools?: string[];
  excludeTools?: string[];
  options?: Record<string, any>;
  contextLimit?: number;
  autoSummary?: boolean;
  logLevel?: LogLevel;
  apiKey?: string;
  provider?: LLMProvider;
  name?: string;
  remoteContextUrl?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  routingPolicy?: Partial<ToolRoutingPolicy>;
  /** Injected todo persistence; defaults to in-memory when omitted. */
  todoStore?: TodoStore;
  /** Active behavioral policy (tool allow-list, gates). */
  policy?: AgentPolicy;
  /** When set, enables delegate_task with this child profile/key. */
  delegation?: AgentDelegationConfig;
}

export interface AgentTemplate {
  name: string;
  order?: number;
  systemPrompt?: string;
  workflow?: string;
  rules?: string[];
  toolPresets?: ToolPresetName[];
  includeTools?: string[];
  excludeTools?: string[];
  defaultTools?: {
    read?: boolean;
    write?: boolean;
    execute?: boolean;
    tasks?: boolean;
    search?: boolean;
    grep?: boolean;
  };
  thinking?: boolean;
  deepThinking?: boolean;
  options?: Record<string, any>;
  contextLimit?: number;
  autoSummary?: boolean;
  logLevel?: LogLevel;
  remoteContextUrl?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  routingPolicy?: Partial<ToolRoutingPolicy>;
}
