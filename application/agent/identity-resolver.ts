import type { AgentConfig } from './config.js';

export function resolvePersona(config: AgentConfig): string {
  return config.identity?.trim() || '';
}
