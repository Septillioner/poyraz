# MCP

MCP is optional and off by default. The library connects to MCP servers you pass in. It does **not** read or write any MCP config file: where server definitions are stored is a host concern.

Two ways to use it:

- **On the agent**: `Mcp({ enabled: true, servers })` in the builder. The agent connects in `init()` and owns its connections. See [Optional MCP on the agent](#optional-mcp-on-the-agent).
- **By hand**: the host creates a manager (or uses the shared `mcpClientManager`), connects, and merges the tools with `agent.mergeExternalTools`. See [Connect](#connect).

## Types

```ts
import type { McpServerDef, McpHttpServerDef, McpStdioServerDef } from 'poyraz';
import { isMcpHttpServerDef, mcpClientManager } from 'poyraz';
```

## Connect

```ts
const servers: Record<string, McpServerDef> = {
  docs: {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  },
  remote: {
    url: 'https://example.com/mcp',
    headers: { Authorization: 'Bearer <token>' },
  },
};

const tools = await mcpClientManager.connectAll(servers);
agent.mergeExternalTools(tools);
```

HTTP servers accept `ignoreCertificate: true` to skip TLS certificate verification for that one server only (self-signed or otherwise invalid certificates). It rides on a custom transport `fetch` built on `node:http(s)` with `rejectUnauthorized: false`, so every other connection keeps normal verification.

`connectAll` disconnects existing connections, then connects every enabled entry. Disabled servers (`disabled: true`) are recorded as `disabled` without connecting. A server that cannot be reached is recorded with status `error` and a message; `connectAll` does not throw for it, and the other servers still connect.

`mcpClientManager` is a shared default. For a manager of your own (its own connections, states and `toolPrefix`), use `createMcpClientManager({ toolPrefix })`:

```ts
import { createMcpClientManager } from 'poyraz';

const manager = createMcpClientManager({ toolPrefix: 'ext_' }); // toolPrefix optional
const tools = await manager.connectAll(servers);
manager.getToolPrefix(); // 'ext_'
```

## Tool names

Bridged tools are named `<prefix><serverId>__<toolName>`, with the default prefix `mcp_` (`MCP_TOOL_PREFIX`), for example `mcp_docs__search`. Characters outside `a-z`, `A-Z`, `0-9`, `_`, and `-` become `_`. The name is at most 64 characters, and a collision gets a numeric suffix (`_2`, `_3`, ...). The MCP call still uses the original tool name.

Helpers:

- `mcpToolName(serverId, toolName, used?, prefix?)` builds a name.
- `resolveMcpToolPrefix(prefix?)` gives the effective prefix: trimmed, unsafe characters replaced by `_`, and a missing or blank value becomes `mcp_`.
- `isMcpToolName(name, prefix?)` tells whether a name starts with the effective prefix.

## Optional MCP on the agent

```ts
const agent = new AgentBuilder()
  .Provider(provider)
  .Mcp({ enabled: true, servers, toolPrefix: 'ext_' }) // toolPrefix optional, default 'mcp_'
  .Build();

await agent.init();          // connects the servers and merges their tools (once)
agent.getMcpStates();        // McpServerState[] of this agent's own manager
await agent.connectMcp();    // reconnect (also what init() calls); resolves to the states
await agent.disconnectMcp(); // removes the tools and closes the connections
```

- `mcp.enabled` must be `true` and `mcp.servers` non-empty, otherwise nothing is created or connected. A clean `AgentBuilder()` never touches MCP.
- The agent creates its own `McpClientManager` (`createMcpClientManager({ toolPrefix })`). It does not use the shared `mcpClientManager`, so two agents never share connections or tool names.
- `init()` connects once. A second `init()` does not reconnect, not even servers that failed; call `connectMcp()` to retry.
- `mcp.toolPrefix` names the bridged tools and decides which tools count as the `mcp` [context](context.md) category: a tool is `mcp` when its name starts with `agent.getMcpToolPrefix()`. A host that merges tools from its own manager must give that manager the same prefix, or those tools are counted as plain tools. `removeExternalTools(prefix?)` also defaults to that prefix.
- Merged tools are registered in the agent's own registry (`agent.getToolRegistry()`, layered over the shared one). The shared `toolRegistry` is never written. Tool presentations (labels) of merged tools are therefore found through that registry: pass it to the UI tracker with `createActivityTracker(agent.getToolRegistry())`; without it the tracker only knows the shared registry and shows the raw tool name.
- `mergeExternalTools(tools)` returns the names that replaced an existing tool of the agent (and logs a warning), so a clash is visible. It returns `[]` when nothing was replaced.

### Connection errors do not throw

MCP is optional, so one broken server must not take the agent down. `init()` and `connectMcp()` do **not** throw when a server fails to connect (process cannot start, URL unreachable, handshake error). Instead:

- the server's state has `status: 'error'` and an `error` message, in the array `connectMcp()` returns and in `agent.getMcpStates()`;
- a warning `MCP server failed to connect` (with `server` and `error`) goes to the agent's log;
- the servers that did connect keep working, and their tools are merged. The failed server contributes no tools.

```ts
const states = await agent.connectMcp();
const failed = states.filter((state) => state.status === 'error');
for (const { id, error } of failed) console.warn(`MCP ${id}: ${error}`);
```

What does still throw: a programming or environment fault outside any server (for example the MCP SDK failing to load). A server that accepts the connection but never answers waits for the MCP SDK's own request timeout (60 s by default) before it is reported as an `error`.

## Sync: reconnect only what changed

`connectAll` / `connectMcp()` drop every connection and start over. When a server list is edited (a host settings screen, for example), that restarts servers that did not change. `sync` compares the new list with the current connections and touches only the difference:

```ts
// On an agent (needs mcp.enabled: true)
const result = await agent.syncMcp(nextServers);          // nextServers defaults to config.mcp.servers
const again = await agent.syncMcp(nextServers, { retryFailed: true });

// On a manager of your own
const manager = createMcpClientManager();
const synced = await manager.sync(nextServers);
agent.mergeExternalTools(synced.tools);
```

Signatures:

```ts
agent.syncMcp(servers?: Record<string, McpServerDef>, options?: McpSyncOptions): Promise<McpSyncResult>
manager.sync(servers: Record<string, McpServerDef>, options?: McpSyncOptions): Promise<McpSyncResult>

interface McpSyncOptions {
  retryFailed?: boolean; // also reconnect unchanged servers whose last attempt failed. Default false
}

interface McpSyncResult {
  added: string[];      // not known before: connected (or recorded as 'disabled')
  changed: string[];    // definition changed: disconnected, then connected with the new one
  removed: string[];    // no longer in the list: disconnected and forgotten
  unchanged: string[];  // identical definition: not touched
  retried: string[];    // unchanged but failed before, reconnected (retryFailed)
  states: McpServerState[]; // state of every requested server, in request order
  tools: Record<string, ToolDefinition>; // bridged tools of all connected servers
}
```

Rules:

- **Equality** is by value, independent of key order (`env`, `headers`, `args` entries of an object), so an edited-and-saved-again server is `unchanged`. Order inside `args` matters. `disabled: false` and `ignoreCertificate: false` equal leaving them out. Any other difference (`url`, `headers`, `command`, `args`, `env`, `cwd`, `disabled`, `ignoreCertificate`) makes the server `changed`.
- **Unchanged servers are not touched**: same connection, same tool definition objects, nothing is closed or reopened. On an agent, their tools stay registered as they are.
- **`ignoreCertificate`** keeps working per server and stays opt-in: it is part of the definition, so switching it reconnects that server only, and only a server that sets it `true` skips TLS verification.
- **Errors do not throw.** A server that fails to connect has `status: 'error'` and an `error` text in `states`, and the agent logs `MCP server failed to connect` for servers it tried in this call. The others still connect. A failed server whose definition did not change is **not** retried by a later `sync` unless `retryFailed: true` (so an unrelated edit does not hammer a broken server); a changed definition always reconnects.
- **Concurrent calls are serialized.** Calls on one manager (`sync`, `connectAll`, `connect`, `disconnect`, `disconnectAll`) run one after the other in call order; a call that fails does not block the next. On an agent, `connectMcp()`, `syncMcp()` and `disconnectMcp()` share one queue the same way, so their effects never interleave.
- **`mcp.enabled` off** (missing, `false`, or `mcp` not set): `agent.syncMcp(...)` does nothing. It creates no manager, connects nothing, leaves `config.mcp` unchanged and returns an empty result (`added`, `changed`, `removed`, `unchanged`, `retried`, `states` empty, `tools: {}`). Connections that already exist are not closed by it; `disconnectMcp()` does that. With `enabled: true` and no servers, a first `syncMcp()` also creates nothing.
- **`config.mcp.servers`** becomes the synced list on an agent, so a later `connectMcp()` reconnects the same set. `toolPrefix` is unchanged.
- **Tools on the agent**: tools of `removed` servers (and the old tools of `changed` ones) are removed from the agent, new ones are merged. Tools you merged yourself with another prefix are left alone.
- `manager.connectAll(servers)` records the definitions too, so a `sync` after it sees those servers as `unchanged`. `manager.disconnect(id)` now also forgets the server's state.

The shared host pattern (reconnect everything whenever the list changes) becomes `await agent.syncMcp(servers)`; the host no longer needs a `connectedKey`.

## Status

```ts
const states = mcpClientManager.listStates(); // or agent.getMcpStates()
// McpServerState: { id, status: 'connected' | 'error' | 'disabled', toolCount, tools: [{ name, description }], error? }
```
