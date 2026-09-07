# Templates

Templates are JSON personas: identity, tools, and routing defaults. The npm package includes bundled templates (for example `poyraz-2.0`). Your app can load them by name or build from an `AgentTemplate` object.

## Template fields

Type: `AgentTemplate` from `poyraz`.

| Field | Purpose |
|-------|---------|
| `name` | Template id |
| `identity` | System identity text |
| `toolPresets` / `defaultTools` | Which built-ins to enable |
| `includeTools` / `excludeTools` | Fine-grained selection |
| `contextLimit` / `autoSummary` | Context behavior |
| `routingPolicy` | `maxToolRounds`, `repeatCallLimit`, `deterministicMode` |
| `options` | Model options (`temperature`, `num_ctx`, …) |
| `promptCacheRetention` | e.g. `24h` / `in_memory` |
| `logLevel` | Logger level |
| `order` | Sort key when listing |

## Load by name

On first use, bundled templates sync into `~/.poyraz/data/configs/templates/` when no project `data/configs` directory is present.

```ts
import { templateRegistry, openAiProfile } from 'poyraz';

const agent = templateRegistry.get('poyraz-2.0', openAiProfile('gpt-4o-mini'));
await agent.init();
```

`templateRegistry.list()` lists available templates. `buildAgent(name, modelProfile?)` is the same as `get`.

## Build from JSON in your app

```ts
import { readFileSync } from 'fs';
import { AgentBuilder, openAiProfile, type AgentTemplate } from 'poyraz';

const template = JSON.parse(readFileSync('./my-agent.json', 'utf8')) as AgentTemplate;

const agent = new AgentBuilder()
  .FromTemplate(template)
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .Build();
```

## Add your own template

1. Start from the bundled `poyraz-2.0` JSON (or any `AgentTemplate`-shaped file).
2. Set a unique `name` and `identity`.
3. Save it under `~/.poyraz/data/configs/templates/` (or your project’s `data/configs/templates/` if you use that layout).
4. Load with `templateRegistry.get('<name>')` or `FromTemplate` / `FromJSON`.
