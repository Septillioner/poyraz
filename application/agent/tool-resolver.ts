import type { ToolDefinition } from '../../tools/core/types.js';
import type { ToolPresetName } from '../../tools/core/registry.js';
import type { AgentConfig } from './config.js';

/**
 * Tools of a config: exactly the explicit `tools` (the builder resolves presets and names into it).
 * Nothing is implied from any registry; no `tools` means no tools.
 */
export function resolveAgentTools(config: AgentConfig): Record<string, ToolDefinition> {
  return { ...(config.tools ?? {}) };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * Order: `maxToolRounds`, `policy.maxToolRounds`, `routingPolicy.maxToolRounds`,
 * `options.max_tool_rounds`, then 10.
 */
export function resolveMaxToolRounds(config: AgentConfig): number {
  return (
    positiveInt(config.maxToolRounds) ??
    positiveInt(config.policy?.maxToolRounds) ??
    positiveInt(config.routingPolicy?.maxToolRounds) ??
    positiveInt(config.options?.max_tool_rounds) ??
    10
  );
}

/** Order: `repeatCallLimit`, `routingPolicy.repeatCallLimit`, `options.repeat_call_limit`, then 2. */
export function resolveRepeatCallLimit(config: AgentConfig): number {
  return (
    positiveInt(config.repeatCallLimit) ??
    positiveInt(config.routingPolicy?.repeatCallLimit) ??
    positiveInt(config.options?.repeat_call_limit) ??
    2
  );
}

export type { ToolPresetName };
