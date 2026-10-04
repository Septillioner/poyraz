# Agent policy

Poyraz does not ship CLI modes (`agent` / `plan` / `ask` / `chat`). Those live in `poyraz-cli`. The library exposes a generic **AgentPolicy** that controls tools and response gates. Mode or profession text belongs in `.SystemPrompt(...)`, not in the policy.

```ts
import { AgentBuilder, DEFAULT_AGENT_POLICY, type AgentPolicy } from 'poyraz';

const readOnly: AgentPolicy = {
  id: 'ask',
  allowedTools: ['read_file', 'list_dir', 'glob_file_search', 'grep'],
  hardBlockDeniedTools: true,
  deniedToolReason: 'This tool is disabled under the active policy.',
};

const agent = new AgentBuilder()
  .SystemPrompt('Answer with read-only tools only.')
  .Policy(readOnly)
  .WithPresets('filesystem', 'search')
  .Build();

agent.setPolicy({ ...DEFAULT_AGENT_POLICY, id: 'agent' });
```

## AgentPolicy fields

| Field | Role |
|-------|------|
| `id` | Stable policy id (hosts may map this to a UX mode name) |
| `allowedTools` | `'all'` or an allow-list of tool names |
| `hardBlockDeniedTools` | When true, circuit breakers hard-stop denied tool loops |
| `deniedToolReason` | Message returned when a tool is denied |
| `bufferTextUntilAccepted` | Buffer `text.delta` until a text-only reply passes gates |
| `perTurnToolLimits` | e.g. `{ write_file: 1 }` |
| `responseGates` | Ordered gates evaluated before accepting a final text reply |

## ResponseGate

```ts
import type { ResponseGate } from 'poyraz';

const gate: ResponseGate = {
  maxRetries: 2,
  evaluate({ content, succeededTools }) {
    if (content.includes('```') && !succeededTools.has('read_file')) {
      return { kind: 'retry', notice: '<system_reminder>Rewrite without code fences.</system_reminder>' };
    }
    return { kind: 'accept' };
  },
  onExhausted: (content) => content.replace(/```[\s\S]*?```/g, '').trim(),
};
```

## Default policy

`DEFAULT_AGENT_POLICY` is `{ id: 'default', allowedTools: 'all' }`.

## CLI modes

`poyraz-cli` maps `agent` / `plan` / `ask` / `chat` onto `AgentPolicy` values and mode text in `SystemPrompt` (including plan response gates). See the CLI `docs/models-and-modes.md`.
