# Templates

Agent templates are plain JSON configs consumed by `AgentBuilder.FromTemplate` / `FromJSON`. The library does **not** sync templates to disk or maintain a template registry; storing and discovering templates is up to the host application.

A template carries only what you put in it. Leave a section out and the feature stays off, exactly like a clean `AgentBuilder()`.

```ts
import { AgentBuilder, type AgentTemplate } from 'poyraz';

const template: AgentTemplate = {
  name: 'researcher',
  systemPrompt: 'You research codebases thoroughly.',
  toolPresets: ['filesystem', 'search'],
  contextLimit: 200,
  summarization: { enabled: true, thresholdRatio: 0.8 },
  repair: { enabled: true },
  policy: { allowedTools: ['read_file', 'list_dir', 'grep'] },
};

const agent = new AgentBuilder()
  .FromTemplate(template)
  .ApiKey(apiKey)
  .WithModelProfile(profile)
  .Build();
```

`AgentTemplate` is the JSON-serializable subset of `AgentConfig`: no `provider`, `apiKey`, `continuation` or response gates (those are code), `summarization.prompt` must be a string, and `repair` has no `resolvers` / `generic`. It also keeps `toolPresets`, `includeTools` and `defaultTools`, which `FromJSON` turns into builder calls; `AgentConfig` itself has none of them (it holds the resolved `tools`). The type has no `model`, `host` or `provider` keys: set those with `WithModelProfile`, `Model`, `RemoteModel` or `Provider`. `FromJSON` still reads `model`, `host`, `localModel`, `remoteModel` and `apiKey` from a plain JSON object, and also accepts a `continuation` policy object when you build the JSON in code. Keys the library no longer knows (`deterministicMode`, `workflow`, `thinking`, `deepThinking`, `order`, `remoteContextUrl`, `identity`) are ignored, so old template files still load.

See `AgentTemplate` in the package types for all fields, and [Agent API](agent-api.md#json) for the list `FromJSON` reads.
