# MCP

Attach [Model Context Protocol](https://modelcontextprotocol.io/) servers so their tools appear on your agent.

## Config file

Default path: `~/.poyraz/mcp.json` (`resolveMcpConfigPath()`). Keep tokens here (or inject headers from env) — do not commit secrets into your app repo.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allowed"],
      "disabled": false
    },
    "remote": {
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_TOKEN"
      },
      "disabled": false
    }
  }
}
```

- **stdio:** `command`, optional `args`, `env`, `cwd`, `disabled`
- **HTTP:** `url`, optional `headers`, `disabled`

Helpers: `loadMcpConfig`, `saveMcpConfig`, `addMcpServer`, `removeMcpServer`, `listMcpServers`, `getMcpServer`, `setMcpServerDisabled`, `isMcpHttpServerDef`.

## Connect and merge into an agent

```ts
import { AgentBuilder, openAiProfile, mcpClientManager } from 'poyraz';

const agent = new AgentBuilder()
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .Build();

await agent.init();

const mcpTools = await mcpClientManager.connectAll();
agent.mergeExternalTools(mcpTools);

// later
agent.removeExternalTools(); // default prefix mcp_
await mcpClientManager.disconnectAll();
```

`mcpClientManager` API:

- `connectAll()` — reload config, connect enabled servers, return merged tools
- `connect(id, def)` / `disconnect(id)` / `disconnectAll()`
- `getTools()` — current merged map
- `listStates()` — `{ id, status, toolCount, error? }` (`connected` \| `error` \| `disabled`)

## Tool naming

Bridged tools are named `mcp_<serverId>__<toolName>` (`MCP_TOOL_PREFIX`, `mcpToolName(serverId, toolName)`).

## Modes

MCP tools are part of the base set but only usable in `agent` mode under the default mode allowlists. See [Modes](modes.md).
