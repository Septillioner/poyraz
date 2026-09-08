import type { ToolDefinition } from '../../tools/core/types.js';
import { toolRegistry, type ToolPresetName } from '../../tools/core/registry.js';
import type { AgentConfig } from './config.js';

function allRegisteredTools(): Record<string, ToolDefinition> {
  return Object.fromEntries(toolRegistry.list().map((def) => [def.name, def]));
}

export function resolveAgentTools(config: AgentConfig): Record<string, ToolDefinition> {
  if (config.tools && Object.keys(config.tools).length > 0) {
    return { ...config.tools };
  }

  if (config.toolPresets?.length || config.includeTools?.length || config.excludeTools?.length) {
    return toolRegistry.resolveToolSet({
      presets: config.toolPresets,
      include: config.includeTools,
      exclude: config.excludeTools,
    });
  }

  return allRegisteredTools();
}

export function resolveMaxToolRounds(config: AgentConfig): number {
  const fromConfig = config.routingPolicy?.maxToolRounds;
  if (typeof fromConfig === 'number' && fromConfig > 0) return Math.floor(fromConfig);
  const fromOptions = config.options?.max_tool_rounds;
  if (typeof fromOptions === 'number' && fromOptions > 0) return Math.floor(fromOptions);
  return 10;
}

export function resolveRepeatCallLimit(config: AgentConfig): number {
  const fromConfig = config.routingPolicy?.repeatCallLimit;
  if (typeof fromConfig === 'number' && fromConfig > 0) return Math.floor(fromConfig);
  const fromOptions = config.options?.repeat_call_limit;
  if (typeof fromOptions === 'number' && fromOptions > 0) return Math.floor(fromOptions);
  return 2;
}

export type { ToolPresetName };
