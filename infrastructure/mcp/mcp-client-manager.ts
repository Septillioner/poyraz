import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isMcpHttpServerDef, type McpServerDef } from '../../domain/mcp.js';
import type { ToolDefinition } from '../../tools/core/types.js';
import { bridgeMcpTool, resolveMcpToolPrefix } from './mcp-tool-bridge.js';
import { insecureFetch } from './insecure-fetch.js';

export type McpConnectionStatus = 'connected' | 'error' | 'disabled';

export interface McpListedTool {
  name: string;
  description: string;
}

export interface McpServerState {
  id: string;
  status: McpConnectionStatus;
  toolCount: number;
  tools: McpListedTool[];
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
      fetch: def.ignoreCertificate ? insecureFetch : undefined,
    });
  }
  return new StdioClientTransport({
    command: def.command,
    args: def.args,
    env: def.env,
    cwd: def.cwd,
  });
}

function listedTools(tools: { name?: string; description?: string }[]): McpListedTool[] {
  const listed: McpListedTool[] = [];
  for (const tool of tools) {
    const name = typeof tool.name === 'string' ? tool.name.trim() : '';
    if (!name) continue;
    const description = typeof tool.description === 'string' ? tool.description.trim() : '';
    listed.push({ name, description });
  }
  return listed;
}

/**
 * Node's native fetch wraps the real cause (DNS failure, connection refused, TLS error, ...)
 * inside `error.cause` and only exposes the generic "fetch failed" on `error.message`.
 * Unwrap it so `/mcp list` shows something actionable instead of just "fetch failed".
 */
function describeConnectError(error: any): string {
  const detail = error?.cause ?? error;
  const code = detail.code ? `${detail.code}: ` : '';
  return `${code}${detail.message ?? String(detail)}`;
}

/** Order-independent text form of a server definition, used to tell whether a server changed. */
export function mcpServerKey(def: McpServerDef): string {
  return JSON.stringify(normalizeForKey(def));
}

function normalizeForKey(value: unknown, topLevel = true): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForKey(item, false));
  if (value === null || typeof value !== 'object') return value;
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item === undefined) continue;
    // `disabled: false` and `ignoreCertificate: false` are the defaults: same as leaving them out.
    if (topLevel && (key === 'disabled' || key === 'ignoreCertificate') && item === false) continue;
    entries.push([key, normalizeForKey(item, false)]);
  }
  return Object.fromEntries(entries);
}

export interface McpSyncOptions {
  /** Also reconnect unchanged servers whose last attempt failed (`status: 'error'`). Default false. */
  retryFailed?: boolean;
}

/** What `sync` did, by server id, plus the resulting state of every requested server. */
export interface McpSyncResult {
  /** Servers that were not known before: connected (or recorded as `disabled`). */
  added: string[];
  /** Servers whose definition changed: disconnected, then connected again with the new one. */
  changed: string[];
  /** Servers no longer requested: disconnected and forgotten. */
  removed: string[];
  /** Servers with an identical definition: not touched. */
  unchanged: string[];
  /** Unchanged servers that had failed and were reconnected (`retryFailed`). */
  retried: string[];
  /** State of every requested server, in the order of the request. */
  states: McpServerState[];
  /** Bridged tools of all connected servers (unchanged servers keep the same definition objects). */
  tools: Record<string, ToolDefinition>;
}

export interface McpClientManagerOptions {
  /** Name prefix of bridged tools. Omitted -> `MCP_TOOL_PREFIX` (`mcp_`). */
  toolPrefix?: string;
}

/**
 * Owns one connection per configured MCP server and exposes their tools as a merged set.
 * Instances are independent: an agent with `mcp.enabled` creates its own, so connections, states and
 * tool names are never shared between agents. The exported `mcpClientManager` is a shared default
 * for hosts that manage MCP themselves.
 */
export class McpClientManager {
  private connections = new Map<string, McpConnection>();
  private states = new Map<string, McpServerState>();
  /** Stable key of the definition each known server was last connected with. */
  private keys = new Map<string, string>();
  private readonly toolPrefix: string;
  /** Tail of the queue that serializes every operation that changes connections. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: McpClientManagerOptions = {}) {
    this.toolPrefix = resolveMcpToolPrefix(options.toolPrefix);
  }

  /** The prefix bridged tool names of this manager start with. */
  getToolPrefix(): string {
    return this.toolPrefix;
  }

  /**
   * Runs `task` after every earlier operation finished. Calls that change connections
   * (`connectAll`, `sync`, `connect`, `disconnect`, `disconnectAll`) never overlap: they run one
   * after the other in call order, and one that fails does not block the next.
   */
  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Disconnects all current connections and reconnects every server in `servers`. */
  connectAll(servers: Record<string, McpServerDef>): Promise<Record<string, ToolDefinition>> {
    return this.exclusive(async () => {
      await this.disconnectAllNow();
      const used = new Set<string>();
      const entries = Object.entries(servers);
      await Promise.all(entries.map(([id, def]) => this.connectNow(id, def, used)));
      return this.getTools();
    });
  }

  /**
   * Makes the connections match `servers` and touches only what differs:
   * new servers are connected, servers whose definition changed are reconnected, servers that are
   * gone are disconnected, identical ones are left alone (same connection, same tool objects).
   * Definitions are compared by value, independent of key order (`env`, `headers`, ...), and
   * `disabled` / `ignoreCertificate` set to `false` equal leaving them out. A failing server never
   * throws: its state has `status: 'error'`. By default a failed server is not retried while its
   * definition stays the same (`retryFailed` retries it). Concurrent calls run one after the other.
   */
  sync(servers: Record<string, McpServerDef>, options: McpSyncOptions = {}): Promise<McpSyncResult> {
    return this.exclusive(() => this.syncNow(servers, options));
  }

  private async syncNow(servers: Record<string, McpServerDef>, options: McpSyncOptions): Promise<McpSyncResult> {
    const wanted = Object.entries(servers);
    const requested = new Set(wanted.map(([id]) => id));
    const added: string[] = [];
    const changed: string[] = [];
    const unchanged: string[] = [];
    const retried: string[] = [];
    const removed = Array.from(this.keys.keys()).filter((id) => !requested.has(id));

    for (const [id, def] of wanted) {
      const previous = this.keys.get(id);
      if (previous === undefined) added.push(id);
      else if (previous !== mcpServerKey(def)) changed.push(id);
      else if (options.retryFailed === true && this.states.get(id)?.status === 'error') retried.push(id);
      else unchanged.push(id);
    }

    await Promise.all([...removed, ...changed, ...retried].map((id) => this.dropNow(id)));

    const used = new Set<string>();
    for (const connection of this.connections.values()) {
      for (const name of Object.keys(connection.tools)) used.add(name);
    }
    await Promise.all([...added, ...changed, ...retried].map((id) => this.connectNow(id, servers[id], used)));

    // Order of the request, nothing else left over.
    const ordered = new Map<string, McpServerState>();
    for (const [id] of wanted) {
      const state = this.states.get(id);
      if (state) ordered.set(id, state);
    }
    this.states = ordered;

    return {
      added,
      changed,
      removed,
      unchanged,
      retried,
      states: this.listStates(),
      tools: this.getTools(),
    };
  }

  /** Connects one server (replacing its connection when it already has one). Never throws for a failing server. */
  connect(id: string, def: McpServerDef, used?: Set<string>): Promise<void> {
    return this.exclusive(async () => {
      await this.dropNow(id);
      await this.connectNow(id, def, used);
    });
  }

  private async connectNow(id: string, def: McpServerDef, used?: Set<string>): Promise<void> {
    this.keys.set(id, mcpServerKey(def));
    if (def.disabled) {
      this.states.set(id, { id, status: 'disabled', toolCount: 0, tools: [] });
      return;
    }

    let client: Client | undefined;
    try {
      const transport = createTransport(def);
      client = new Client({ name: 'poyraz', version: '1.0.0' });
      await client.connect(transport);

      const { tools: mcpTools } = await client.listTools();
      const names = used ?? this.namesExcept(id);
      const tools: Record<string, ToolDefinition> = {};
      for (const tool of mcpTools) {
        const bridged = bridgeMcpTool(id, client, tool as any, names, this.toolPrefix);
        tools[bridged.name] = bridged;
      }

      const listed = listedTools(mcpTools);
      this.connections.set(id, { client, transport, tools });
      this.states.set(id, { id, status: 'connected', toolCount: listed.length, tools: listed });
    } catch (error: any) {
      // A half-open connection (handshake done, tool listing failed) must not leak.
      await client?.close().catch(() => undefined);
      this.states.set(id, { id, status: 'error', toolCount: 0, tools: [], error: describeConnectError(error) });
    }
  }

  /** Closes one server's connection and forgets it (state included). */
  disconnect(id: string): Promise<void> {
    return this.exclusive(() => this.dropNow(id));
  }

  private async dropNow(id: string): Promise<void> {
    const connection = this.connections.get(id);
    this.connections.delete(id);
    this.states.delete(id);
    this.keys.delete(id);
    if (!connection) return;
    try {
      await connection.client.close();
    } catch {
      // best-effort close during disconnect/reload
    }
  }

  disconnectAll(): Promise<void> {
    return this.exclusive(() => this.disconnectAllNow());
  }

  private async disconnectAllNow(): Promise<void> {
    const ids = new Set([...this.connections.keys(), ...this.states.keys(), ...this.keys.keys()]);
    await Promise.all(Array.from(ids).map((id) => this.dropNow(id)));
  }

  private namesExcept(id: string): Set<string> {
    const used = new Set<string>();
    for (const [otherId, connection] of this.connections) {
      if (otherId === id) continue;
      for (const name of Object.keys(connection.tools)) used.add(name);
    }
    return used;
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

/** A fresh manager that shares nothing with the default `mcpClientManager` or with other managers. */
export function createMcpClientManager(options: McpClientManagerOptions = {}): McpClientManager {
  return new McpClientManager(options);
}

/** Shared default manager (default prefix). Agents with `mcp.enabled` do not use it, they own one. */
export const mcpClientManager = new McpClientManager();
