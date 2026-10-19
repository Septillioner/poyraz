<div align="center">

# Poyraz

### The runtime behind your AI agents.

An embeddable Node.js library for tool-using agents, connected tools, and your choice of model provider.

[![npm version](https://img.shields.io/npm/v/poyraz?style=flat-square&color=8b5cf6&label=npm)](https://www.npmjs.com/package/poyraz)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-52525b?style=flat-square)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-types%20included-3178c6?style=flat-square)](package.json)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

**[Quick start](#quick-start)** · **[Features](#features)** · **[Providers](#providers)** · **[Documentation](#documentation)** · **[Changelog](CHANGELOG.md)**

</div>

---

## Features

- **Build agents into your application.** Connect a fluent builder and typed events to your backend, CLI, or desktop interface.
- **Choose cloud or local models.** Use OpenAI, Groq, Gemini, OpenRouter, Ollama, llama.cpp, or your own provider implementation.
- **Connect your tools.** Enable filesystem, shell, and search presets, define custom tools with schemas, or connect MCP servers.
- **Control agent execution.** Configure tool allow-lists, response gates, error breakers, and continuation policies.
- **Stream the whole turn.** Receive text, reasoning, tool activity, lifecycle updates, and usage events. Cancel with an `AbortSignal`.
- **Manage context and usage.** Keep session history, enable summarization, inspect context usage, and calculate request costs with your configured token prices.
- **Opt in to runtime features.** Enable repair guidance, bounded rate-limit waiting, and per-agent logging when your application needs them.

Built with **TypeScript** for **Node.js**. Powers agent execution in [Xeck](https://github.com/Septillioner/xeck).

> **Your application stays in control.** Poyraz takes prompts, credentials, policies, and MCP definitions from your host. It does not load `.env` files or create configuration directories.

## Explore

[Install](#quick-start) · [Tools and policy](#add-tools-and-policy) · [Streaming](#stream-a-response) · [Providers](#providers) · [Develop](#development)

---

## Quick start

Requires **Node.js 20 or later**. The package uses **ES modules** and includes TypeScript declarations.

```bash
npm install poyraz
```

Make `OPENAI_API_KEY` available in your application's environment, then create an agent:

```ts
import { AgentBuilder, openAiProfile, resolveApiKeyForProfile } from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const apiKey = resolveApiKeyForProfile(profile, {
  openai: process.env.OPENAI_API_KEY,
});

const agent = new AgentBuilder()
  .Name('assistant')
  .WithModelProfile(profile)
  .ApiKey(apiKey)
  .Build();

await agent.init();

const { content } = await agent.chat('Say hello in one sentence.');
console.log(content);
```

This creates a minimal text agent. A fresh builder adds no system prompt, tools, summarization, logging, or rate-limit waiting. Model options are sent only when you configure them.

See [Getting started](docs/getting-started.md) for configuration examples and a provider stub you can run without an API key.

### Add tools and policy

Extend the quick-start configuration with built-in tools and an explicit allow-list:

```ts
const workspaceAgent = new AgentBuilder()
  .WithModelProfile(profile)
  .ApiKey(apiKey)
  .SystemPrompt('Help the user understand their project files.')
  .WithPresets('filesystem', 'search')
  .Policy({ allowedTools: ['read_file', 'grep'] })
  .MaxToolRounds(10)
  .Build();

await workspaceAgent.init();
const { content } = await workspaceAgent.chat('Read package.json and summarize this project.');
console.log(content);
```

See [Tools](docs/tools.md), [Custom tools](docs/custom-tools.md), and [Agent policy](docs/policy.md) for available tools and policy controls.

### Stream a response

Use the `agent` from the quick start to receive text as it arrives:

```ts
await agent.chat('Explain what an agent runtime does.', {
  onEvent(event) {
    if (event.type === 'text.delta') {
      process.stdout.write(event.delta);
    }
  },
});
```

The same event interface exposes tool activity, context usage, and lifecycle changes. See [Streaming](docs/streaming.md) for the full event reference and cancellation examples.

## Providers

| Provider | Profile helper |
| --- | --- |
| OpenAI | `openAiProfile` |
| Groq | `groqProfile` |
| Google Gemini | `geminiProfile` |
| OpenRouter | `openRouterProfile` |
| Ollama | `ollamaProfile` |
| llama.cpp | `llamaCppProfile` |

Model capabilities vary by provider and model. You can also inject a custom provider with `.Provider(...)` and switch model profiles at runtime.

See [Auth and providers](docs/auth-and-providers.md) for credentials, local endpoints, model discovery, and provider-specific behavior.

## Documentation

| Guide | Topics |
| --- | --- |
| [Getting started](docs/getting-started.md) | Installation, minimal agents, and opt-in configuration |
| [How it works](docs/how-it-works.md) | Runtime concepts and execution flow |
| [Agent API](docs/agent-api.md) | Builder options, agent methods, and tool routing |
| [Tools](docs/tools.md) · [Custom tools](docs/custom-tools.md) | Built-in presets and application-specific tools |
| [Agent policy](docs/policy.md) | Tool restrictions, response gates, and continuation |
| [MCP](docs/mcp.md) | Connecting external tool servers |
| [Streaming](docs/streaming.md) | Events, cancellation, and UI integration |
| [Context](docs/context.md) | History, summarization, and token metering |
| [Rate limits and logging](docs/rate-limit-and-logging.md) | Retry budgets, logs, and debug output |
| [Evaluations](docs/evals.md) | Running evaluations and comparing results |
| [API reference map](docs/API-REFERENCE.md) | Public exports and their reference documentation |

Upgrading from an earlier release? See the [1.0 migration guide](docs/migration-1.0.md).

## Development

Clone the repository and install the locked dependencies:

```bash
git clone https://github.com/Septillioner/poyraz.git
cd poyraz
npm ci
npm test
npm run build
```

Use `npm run test:watch` while developing or `npm run test:coverage` to generate a coverage report.

## Contributing

For bug reports and feature requests, [open an issue](https://github.com/Septillioner/poyraz/issues) with the relevant configuration, reproduction steps, and expected behavior. For code changes, include a focused description and run the tests and build before opening a pull request.

Keep API keys and other secrets out of reports and commits.

---

<div align="center">

**Poyraz** · Licensed under [MIT](LICENSE)

© 2026 Ege

</div>
