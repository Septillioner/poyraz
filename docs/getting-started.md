# Getting started

```bash
npm install poyraz
```

Requires Node.js **>= 20**.

## Minimal agent

A clean builder is a plain text completion. Model profile + API key give you a chat model with no system message, no tools, no summarization, no logging and no rate-limit waiting. Nothing is sent that you did not set (no implicit temperature, `num_ctx`, model or host).

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

`Build()` throws `AgentConfigError` when there is neither a `Provider(...)` nor a model together with a host.

## Turning features on

Every feature is an explicit opt-in:

```ts
import { AgentBuilder, LogLevel } from 'poyraz';

const agent = new AgentBuilder()
  .WithModelProfile(profile)
  .ApiKey(apiKey)
  .Options({ temperature: 0.2 })                  // provider options
  .SystemPrompt('You are a careful assistant.')    // system message
  .WithPresets('filesystem', 'search')             // built-in tools
  .ContextLimit(60)                                // turn limit
  .ContextWindow(128_000)                          // token window, for the meter and summaries
  .Summarization({ enabled: true })                // summarize instead of trimming
  .MaxToolRounds(20)                               // tool loop budget (default 10)
  .Repair(true)                                    // repair text on failed tool results
  .Policy({ allowedTools: ['read_file', 'grep'] }) // tool allow-list
  .RateLimit({ enabled: true, maxWaits: 3 })       // bounded wait on 429
  .Logging({ level: LogLevel.INFO })               // per-agent logging
  .Build();
```

The library does not load `.env` files or touch your home directory. Pass keys, policies and MCP server definitions from your host.

## Next steps

- [Agent API](agent-api.md): every builder method and agent method
- [Auth and providers](auth-and-providers.md)
- [Agent policy](policy.md)
- [Tools](tools.md) and [Custom tools](custom-tools.md)
- [Context and token metering](context.md)
- [MCP](mcp.md)
- [Streaming](streaming.md)
- [Rate limit and logging](rate-limit-and-logging.md)
- [API reference map](API-REFERENCE.md)
