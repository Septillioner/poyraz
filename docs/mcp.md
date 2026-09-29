# MCP

The library connects to MCP servers you pass in. It does **not** read or write `~/.poyraz/mcp.json` — that is a host concern (`poyraz-cli` owns the file CRUD).

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

Bridged tools are prefixed (`mcp_<serverId>_<toolName>`). Use `MCP_TOOL_PREFIX` / `mcpToolName` helpers when needed.

## Status

```ts
const states = mcpClientManager.listStates();
// { id, status: 'connected' | 'error' | 'disabled', toolCount, error? }
```
