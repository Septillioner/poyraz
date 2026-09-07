# Getting started

Integrate Poyraz in a Node.js app in a few steps.

## Requirements

- Node.js **>= 20**
- An API key for a cloud provider, **or** a running [Ollama](https://ollama.com/) instance

## Install

```bash
npm install poyraz
```

## Configure credentials

Set one of:

| Provider | Environment variable |
|----------|----------------------|
| OpenAI | `OPENAI_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Gemini | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Ollama | `OLLAMA_HOST` (optional; default `http://127.0.0.1:11434`) |

You can store the same keys in `~/.poyraz/.env`. Call `loadAllEnv()` at startup if you want Poyraz to load that file (and project `.env` files) into `process.env`. See [Auth and providers](auth-and-providers.md).

## Your first agent

```ts
import { AgentBuilder, openAiProfile, loadAllEnv } from 'poyraz';

loadAllEnv();

const agent = new AgentBuilder()
  .Name('demo')
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .Build();

await agent.init();

const { content, usage } = await agent.chat('Summarize the files in this directory.');
console.log(content);
console.log(usage);
```

### Other providers

```ts
import {
  AgentBuilder,
  groqProfile,
  geminiProfile,
  openRouterProfile,
  ollamaProfile,
} from 'poyraz';

new AgentBuilder().WithModelProfile(groqProfile('llama-3.3-70b-versatile'));
new AgentBuilder().WithModelProfile(geminiProfile('gemini-2.0-flash'));
new AgentBuilder().WithModelProfile(openRouterProfile('anthropic/claude-sonnet-4'));
new AgentBuilder().WithModelProfile(ollamaProfile('llama3.2'));
// or: new AgentBuilder().LocalModel('llama3.2')
```

## Modes

Default mode is `agent` (full access to the tools you configured). Change per turn as needed:

```ts
agent.setMode('plan'); // read + todos only
agent.setMode('ask');  // read-only
agent.setMode('chat'); // no tools
```

See [Modes](modes.md).

## Next steps

- [How it works](how-it-works.md) — runtime model
- [Agent API](agent-api.md) — builder and agent methods
- [Tools](tools.md) — presets and built-ins
- [Streaming](streaming.md) — wire events into your UI
- [MCP](mcp.md) — external tools
