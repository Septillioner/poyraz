import { ToolDefinition } from './types.js';

type DefineToolInput = Omit<ToolDefinition, 'schema'>;

export function defineTool(def: DefineToolInput): ToolDefinition {
  return {
    ...def,
    schema: def.inputSchema,
  };
}
