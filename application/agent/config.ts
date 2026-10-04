import type { LLMProvider, ReasoningConfig, ServiceTier } from '../../domain/llm.js';
import type { AgentPolicy } from '../../domain/agent-policy.js';
import type { ToolPresetName } from '../../tools/core/registry.js';
import type { LogLevel } from '../../shared/logger.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import type { ToolRoutingPolicy } from '../chat/tool-policy.js';

export type { ToolRoutingPolicy };

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export interface AgentConfig {
  model?: string;
  host?: string;
  /** Full system message content. Empty/omitted → no system message. Non-empty rules are appended after it. */
  systemPrompt?: string;
  workflow?: string;
  rules?: string[];
  skills?: Skill[];
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
  reasoning?: ReasoningConfig;
  serviceTier?: ServiceTier;
  routingPolicy?: Partial<ToolRoutingPolicy>;
  /** Active behavioral policy (tool allow-list, gates). */
  policy?: AgentPolicy;
}

export interface AgentTemplate {
  name: string;
  order?: number;
  systemPrompt?: string;
  workflow?: string;
  rules?: string[];
  skills?: Skill[];
  toolPresets?: ToolPresetName[];
  includeTools?: string[];
  excludeTools?: string[];
  defaultTools?: {
    read?: boolean;
    write?: boolean;
    execute?: boolean;
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
  reasoning?: ReasoningConfig;
  routingPolicy?: Partial<ToolRoutingPolicy>;
}
