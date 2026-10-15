# MCP

The library connects to MCP servers you pass in. It does **not** read or write any MCP config file: where server definitions are stored is a host concern.

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
    headers: { Authorization: 'Bearer …' },
  },
};

const tools = await mcpClientManager.connectAll(servers);
agent.mergeExternalTools(tools);
```

`connectAll` disconnects existing connections, then connects every enabled entry. Disabled servers (`disabled: true`) are recorded as `disabled` without connecting.

## Tool names

Bridged tools are prefixed (`mcp_<serverId>__<toolName>`). Characters outside `a-z`, `A-Z`, `0-9`, `_`, and `-` become `_`. The name is at most 64 characters, and a collision on the same connection gets a numeric suffix. The MCP call still uses the original tool name. Use `MCP_TOOL_PREFIX` / `mcpToolName` helpers when needed.

## Optional MCP on the agent

MCP is off by default. A builder can own the connection instead of the host calling `mcpClientManager`:

```ts
const agent = new AgentBuilder()
  .Provider(provider)
  .Mcp({ enabled: true, servers, toolPrefix: 'ext_' }) // toolPrefix optional, default 'mcp_'
  .Build();

await agent.init();          // connects the servers and merges their tools (once)
agent.getMcpStates();        // per-server status of this agent's own manager
await agent.disconnectMcp(); // removes the tools and closes the connections
```

- `mcp.enabled` must be `true` and `mcp.servers` non-empty, otherwise nothing is created or connected.
- The agent creates its own `McpClientManager` (`createMcpClientManager({ toolPrefix })`); it does not use the shared `mcpClientManager`, so two agents never share connections or tool names.
- `mcp.toolPrefix` names the bridged tools (`<prefix><server>__<tool>`) and decides which tools count as the `mcp` context category. A host that merges tools from its own manager must give that manager the same prefix.
- Merged tools are registered in the agent's own registry (`agent.getToolRegistry()`, layered over the shared one). The shared `toolRegistry` is never written. `createActivityTracker(agent.getToolRegistry())` makes UI presentations cover them.
- `mergeExternalTools(tools)` returns the names that replaced an existing tool of the agent (also logged), so a clash is visible.

## Status

```ts
const states = mcpClientManager.listStates();
// { id, status: 'connected' | 'error' | 'disabled', toolCount, error? }
```
