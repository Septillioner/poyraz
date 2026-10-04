# poyraz

Opinionated AI agent runtime for Node.js. Embed it to run tool-using agents with context management, MCP, streaming, and injectable policy — not a thin chat-completions wrapper.

Environment management (`~/.poyraz`, `.env`, CLI modes) lives in **poyraz-cli**, not this package.

## Install

```bash
npm install poyraz
```

Requires Node.js **>= 20**.

## Quick start

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
  .WithPresets('filesystem', 'shell', 'search')
  .Build();

await agent.init();

const { content } = await agent.chat('List files in the current directory.');
console.log(content);
```

Details: [Auth and providers](docs/auth-and-providers.md).

Supported providers: OpenAI, Groq, Gemini, OpenRouter, Ollama.

## What you get

| Capability | Description | Docs |
|------------|-------------|------|
| Agent policy | Generic tool allow-lists and response gates | [Agent policy](docs/modes.md) |
| Built-in tools | Filesystem, shell, search | [Tools](docs/tools.md) |
| Custom tools | `defineTool` + register on the agent | [Custom tools](docs/custom-tools.md) |
| MCP | Connect servers you pass in; merge tools onto the agent | [MCP](docs/mcp.md) |
| Streaming | Fine-grained agent and tool events | [Streaming](docs/streaming.md) |
| Context | Summarization, session history | [How it works](docs/how-it-works.md) |

## Terminal CLI

Install `poyraz-cli` for the REPL, auth/home management, modes, and MCP config file.

## License

MIT
