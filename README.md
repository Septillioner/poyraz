# poyraz

Opinionated AI agent runtime for Node.js. Embed it to run tool-using agents with context management, MCP, streaming, and injectable policy — not a thin chat-completions wrapper.

It is a library, not an application: it reads no `.env`, creates no config directories and defines no behavioral modes. Your host supplies credentials, policies and prompts.

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
  .Build();

await agent.init();

const { content } = await agent.chat('Say hello in one sentence.');
console.log(content);
```

A clean `AgentBuilder()` is a plain text completion: no system message, tools, summarization, logging, rate-limit waiting or MCP, and no model options sent unless you set them. Each feature is an explicit opt-in (`SystemPrompt`, `WithPresets`, `Summarization`, `Repair`, `Policy`, `RateLimit`, `Mcp`, `Logging`, ...). See [Getting started](docs/getting-started.md) and [Agent API](docs/agent-api.md).

Details: [Auth and providers](docs/auth-and-providers.md).

Supported providers: OpenAI, Groq, Gemini, OpenRouter, Ollama, llama.cpp.

## What you get

| Capability | Description | Docs |
|------------|-------------|------|
| Agent policy | Generic tool allow-lists, error breaker and response gates | [Agent policy](docs/policy.md) |
| Tool loop | Opt-in repair text, same-tool breaker, continuation hook | [Agent API](docs/agent-api.md#tool-loop-and-routing) |
| Built-in tools | Filesystem, shell, search | [Tools](docs/tools.md) |
| Custom tools | `defineTool` + register on the agent | [Custom tools](docs/custom-tools.md) |
| MCP | Connect servers you pass in; merge tools onto the agent | [MCP](docs/mcp.md) |
| Streaming | Fine-grained agent and tool events | [Streaming](docs/streaming.md) |
| Context | Opt-in summarization, session history | [Context](docs/context.md#summarization) |
| Rate limit and logging | Bounded wait on 429, per-agent logging and chat debug files, both off by default | [Rate limit and logging](docs/rate-limit-and-logging.md) |
| Context metering | Per-category token estimate vs provider usage, context meter | [Context](docs/context.md) |

Full export map: [API reference map](docs/API-REFERENCE.md).

## License

MIT
