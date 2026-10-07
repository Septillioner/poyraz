import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition, ToolResult } from '../../tools/core/types.js';
import { jsonSchemaToLooseZod } from './json-schema-to-zod.js';

export const MCP_TOOL_PREFIX = 'mcp_';

const PROVIDER_TOOL_NAME_MAX = 64;
const PROVIDER_TOOL_NAME_CHAR = /[^a-zA-Z0-9_-]/g;
const COLLISION_SUFFIX_START = 2;
const NAME_SEPARATOR = '__';

/** Namespaces a server's tool name so ids from different servers never collide in the registry. */
export function mcpToolName(serverId: string, toolName: string, used?: Set<string>): string {
  const base = `${MCP_TOOL_PREFIX}${providerSegment(serverId)}${NAME_SEPARATOR}${providerSegment(toolName)}`;
  if (!used) return fitProviderToolName(base);
  let suffixNumber = COLLISION_SUFFIX_START;
  let candidate = fitProviderToolName(base);
  while (used.has(candidate)) {
    candidate = fitProviderToolName(base, `_${suffixNumber}`);
    suffixNumber += 1;
  }
  used.add(candidate);
  return candidate;
}

function providerSegment(value: string): string {
  return value.replace(PROVIDER_TOOL_NAME_CHAR, '_');
}

function fitProviderToolName(base: string, suffix = ''): string {
  const room = PROVIDER_TOOL_NAME_MAX - suffix.length;
  return `${base.slice(0, Math.max(room, 0))}${suffix}`;
}

export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

function formatToolContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content ?? '');
  }
  return content
    .map((block: any) => {
      if (block?.type === 'text') return block.text;
      if (block?.type === 'resource' && block.resource) {
        return block.resource.text ?? `[resource: ${block.resource.uri}]`;
      }
      return `[${block?.type ?? 'unknown'} content]`;
    })
    .join('\n');
}

export function bridgeMcpTool(serverId: string, client: Client, tool: McpToolInfo, used?: Set<string>): ToolDefinition {
  const name = mcpToolName(serverId, tool.name, used);

  return {
    name,
    description: tool.description || `MCP tool "${tool.name}" from server "${serverId}".`,
    inputSchema: jsonSchemaToLooseZod(tool.inputSchema),
    parametersJsonSchema: tool.inputSchema,
    execute: async (args, context): Promise<ToolResult> => {
      try {
        const result = await client.callTool(
          { name: tool.name, arguments: args },
          undefined,
          context.abortSignal ? { signal: context.abortSignal } : undefined,
        );
        return {
          content: formatToolContent((result as any).content),
          isError: Boolean((result as any).isError),
        };
      } catch (error: any) {
        return { content: `MCP tool call failed: ${error.message}`, isError: true };
      }
    },
    presentation: {
      label: `MCP: ${tool.name}`,
      category: 'network',
    },
    meta: {
      category: 'network',
    },
  };
}
