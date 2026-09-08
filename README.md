# poyraz

Opinionated AI agent runtime for Node.js. Embed it in your app to run **tool-using agents** with modes, MCP, and streaming — not a thin chat-completions wrapper.

## Install

```bash
npm install poyraz
```

Requires Node.js **>= 20**.

## Quick start

```ts
import { AgentBuilder, openAiProfile } from 'poyraz';

const agent = new AgentBuilder()
  .Name('demo')
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .Build();

await agent.init();

const { content } = await agent.chat('List files in the current directory.');
console.log(content);
```

Set `OPENAI_API_KEY` (or another provider key) in the environment or in `~/.poyraz/.env`. Details: [Auth and providers](docs/auth-and-providers.md).

Supported providers: OpenAI, Groq, Gemini, OpenRouter, Ollama.

## What you get

| Capability | Description | Docs |
|------------|-------------|------|
| Modes | `agent` / `plan` / `ask` / `chat` with different tool access | [Modes](docs/modes.md) |
| Built-in tools | Filesystem, shell, search, todos | [Tools](docs/tools.md) |
| Custom tools | `defineTool` + register on the agent | [Custom tools](docs/custom-tools.md) |
| Streaming | Token and tool events for your UI | [Streaming](docs/streaming.md) |
| MCP | Attach stdio/HTTP MCP servers as tools | [MCP](docs/mcp.md) |
| Templates | JSON personas (`poyraz-2.0` and your own) | [Templates](docs/templates.md) |
| Subagents | Cheaper `delegate_task` workers when `SUBAGENT_MODEL` is set | [Subagents](docs/subagents.md) |

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting started](docs/getting-started.md) | First agent in your project |
| [How it works](docs/how-it-works.md) | Runtime model: agent, tools, providers, home dirs |
| [Agent API](docs/agent-api.md) | `AgentBuilder` and `Agent` |
| [Modes](docs/modes.md) | Mode behavior and tool gates |
| [Tools](docs/tools.md) | Presets and built-in tools |
| [Auth and providers](docs/auth-and-providers.md) | API keys, profiles, `~/.poyraz` |
| [MCP](docs/mcp.md) | Config, connect, merge tools |
| [Templates](docs/templates.md) | Bundled and custom templates |
| [Subagents](docs/subagents.md) | `delegate_task` and `SUBAGENT_MODEL` |
| [Workspace](docs/workspace.md) | Project `.poyraz/`, trust, logs |
| [Streaming](docs/streaming.md) | Events and cancellation |
| [Custom tools](docs/custom-tools.md) | Add your own tools |
| [Evals](docs/evals.md) | Optional: measure agents from the git repo |

## CLI

For an interactive terminal REPL, install the separate package:

```bash
npm install -g poyraz-cli
poyraz
```

`poyraz` (this package) is the library; `poyraz-cli` is the companion CLI that embeds it.

## License

MIT
