import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isMcpHttpServerDef, loadMcpConfig, type McpServerDef } from '../persistence/mcp-config.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import { bridgeMcpTool } from './mcp-tool-bridge.js';

export type McpConnectionStatus = 'connected' | 'error' | 'disabled';

export interface McpServerState {
  id: string;
  status: McpConnectionStatus;
  toolCount: number;
  error?: string;
}

interface McpConnection {
  client: Client;
  transport: Transport;
  tools: Record<string, ToolDefinition>;
}

function createTransport(def: McpServerDef): Transport {
  if (isMcpHttpServerDef(def)) {
    return new StreamableHTTPClientTransport(new URL(def.url), {
      requestInit: def.headers ? { headers: def.headers } : undefined,
    });
  }
  return new StdioClientTransport({
    command: def.command,
    args: def.args,
    env: def.env,
    cwd: def.cwd,
  });
}

/**
 * Node's native fetch wraps the real cause (DNS failure, connection refused, TLS error, ...)
 * inside `error.cause` and only exposes the generic "fetch failed" on `error.message`.
 * Unwrap it so `/mcp list` shows something actionable instead of just "fetch failed".
 */
function describeConnectError(error: any): string {
  const cause = error?.cause;
  if (cause) {
    const code = cause.code ? `${cause.code}: ` : '';
    return `${code}${cause.message ?? String(cause)}`;
  }
  return error?.message ?? String(error);
}

/** Owns one child-process connection per configured MCP server and exposes their tools as a merged set. */
class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private states = new Map<string, McpServerState>();

  /** Disconnects all current connections, reads the config fresh, and reconnects every enabled server. */
  async connectAll(): Promise<Record<string, ToolDefinition>> {
    await this.disconnectAll();
    const config = loadMcpConfig();
    const entries = Object.entries(config.mcpServers);

    await Promise.all(entries.map(([id, def]) => this.connect(id, def)));

    return this.getTools();
  }

  async connect(id: string, def: McpServerDef): Promise<void> {
    if (def.disabled) {
      this.states.set(id, { id, status: 'disabled', toolCount: 0 });
      return;
    }

    try {
      const transport = createTransport(def);
      const client = new Client({ name: 'poyraz', version: '1.0.0' });
      await client.connect(transport);

      const { tools: mcpTools } = await client.listTools();
      const tools: Record<string, ToolDefinition> = {};
      for (const tool of mcpTools) {
        const bridged = bridgeMcpTool(id, client, tool as any);
        tools[bridged.name] = bridged;
      }

      this.connections.set(id, { client, transport, tools });
      this.states.set(id, { id, status: 'connected', toolCount: mcpTools.length });
    } catch (error: any) {
      this.states.set(id, { id, status: 'error', toolCount: 0, error: describeConnectError(error) });
    }
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch {
      // best-effort close during disconnect/reload
    }
    this.connections.delete(id);
  }

  async disconnectAll(): Promise<void> {
    await Promise.all(Array.from(this.connections.keys()).map((id) => this.disconnect(id)));
    this.states.clear();
  }

  getTools(): Record<string, ToolDefinition> {
    const tools: Record<string, ToolDefinition> = {};
    for (const connection of this.connections.values()) {
      Object.assign(tools, connection.tools);
    }
    return tools;
  }

  listStates(): McpServerState[] {
    return Array.from(this.states.values());
  }
}

export const mcpClientManager = new McpClientManager();
