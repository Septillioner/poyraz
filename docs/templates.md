# Templates

Agent templates are plain JSON configs consumed by `AgentBuilder.FromTemplate` / `FromJSON`. The library does **not** sync templates to `~/.poyraz` or maintain a template registry — that belongs in the host (`poyraz-cli`).

```ts
import { AgentBuilder, type AgentTemplate } from 'poyraz';

const template: AgentTemplate = {
  name: 'researcher',
  systemPrompt: 'You research codebases thoroughly.',
  toolPresets: ['filesystem', 'search'],
  contextLimit: 200,
  autoSummary: true,
};

const agent = new AgentBuilder()
  .FromTemplate(template)
  .ApiKey(apiKey)
  .WithModelProfile(profile)
  .Build();
```

See `AgentTemplate` in the package types for all fields.
