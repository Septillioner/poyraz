import { fsToolDefinitions } from './definitions/fs.js';
import { systemToolDefinitions } from './definitions/system.js';
import { planningToolDefinitions } from './definitions/planning.js';
import { grepToolDefinitions } from './definitions/grep.js';
import { delegationToolDefinitions } from './definitions/delegation.js';
import { toolRegistry } from './core/registry.js';

export * from './core/types.js';
export * from './core/define-tool.js';
export * from './core/presentations.js';
export * from './core/edit-diff.js';
export * from './core/shell-session.js';
export * from './core/registry.js';

toolRegistry.registerMany([
  ...fsToolDefinitions,
  ...systemToolDefinitions,
  ...planningToolDefinitions,
  ...grepToolDefinitions,
  ...delegationToolDefinitions,
]);

export const builtinTools = Object.fromEntries(
  toolRegistry.list().map((def) => [def.name, def])
);
