# Getting started

```bash
npm install poyraz
```

Requires Node.js **>= 20**.

## Minimal agent

Name + model profile + API key yields a bare chat model (no tools, no system message). Add `.SystemPrompt(...)` and tools explicitly when you need them.

```ts
import { AgentBuilder, openAiProfile, resolveApiKeyForProfile } from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const apiKey = resolveApiKeyForProfile(profile, {
  openai: process.env.OPENAI_API_KEY,
});

const agent = new AgentBuilder()
  .Name('demo')
  .WithModelProfile(profile)
  .ApiKey(apiKey)
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .Build();

await agent.init();

const { content } = await agent.chat('List files in the current directory.');
console.log(content);
```

The library does not load `.env` files. Pass keys (and optional `TodoStore`, `AgentPolicy`, MCP server defs) from your host.

## Next steps

- [Auth and providers](auth-and-providers.md)
- [Agent policy](modes.md) (generic policies; CLI modes live in poyraz-cli)
- [Tools](tools.md)
- [MCP](mcp.md)
- [Subagents](subagents.md)
- [Agent API](agent-api.md)
