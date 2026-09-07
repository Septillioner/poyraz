import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition, ToolResult } from '../../tools/core/types.js';
import { jsonSchemaToLooseZod } from './json-schema-to-zod.js';

export const MCP_TOOL_PREFIX = 'mcp_';

/** Namespaces a server's tool name so ids from different servers never collide in the registry. */
export function mcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverId}__${toolName}`;
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

export function bridgeMcpTool(serverId: string, client: Client, tool: McpToolInfo): ToolDefinition {
  const name = mcpToolName(serverId, tool.name);

  return {
    name,
    description: tool.description || `MCP tool "${tool.name}" from server "${serverId}".`,
    inputSchema: jsonSchemaToLooseZod(tool.inputSchema),
    parametersJsonSchema: tool.inputSchema,
    execute: async (args): Promise<ToolResult> => {
      try {
        const result = await client.callTool({ name: tool.name, arguments: args });
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
