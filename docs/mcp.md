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

## Status

```ts
const states = mcpClientManager.listStates(); // or agent.getMcpStates()
// McpServerState: { id, status: 'connected' | 'error' | 'disabled', toolCount, tools: [{ name, description }], error? }
```
