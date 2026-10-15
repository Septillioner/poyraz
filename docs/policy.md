# Agent policy

`AgentPolicy` is the one generic knob the library gives you over what an agent may do. It controls which tools are allowed, what happens when a denied tool is called, per-turn tool caps, the same-error circuit breaker and response gates. The library has no notion of "modes" or personas: a host that wants a read-only agent, a planning agent or a no-tools agent builds the matching policy and, where the model needs to know about it, says so in `.SystemPrompt(...)`.

Everything is optional. A policy you leave out, or fields you omit, mean "permissive": every tool of the agent is allowed, no gates, breaker off.

```ts
import { AgentBuilder } from 'poyraz';

const agent = new AgentBuilder()
  .Provider(provider)
  .SystemPrompt('You may read and search files, but you must not change anything.')
  .WithPresets('filesystem', 'search')
  .Policy({
    id: 'read-only',
    allowedTools: ['read_file', 'list_dir', 'glob_file_search', 'grep'],
    hardBlockDeniedTools: true,
    deniedToolReason: 'This tool is disabled under the active policy.',
  })
  .Build();
```

## Setting a policy

| Where | How |
|-------|-----|
| Builder | `Policy(config)` replaces the whole section. `AllowedTools(list \| 'all')`, `ErrorBreaker(mode)`, `ResponseGates(...gates)` and `PerTurnToolLimits(map)` change one field and keep the rest |
| Config / JSON | `policy` field of `AgentConfig`, `AgentTemplate` (without `responseGates`, which are code) and `FromJSON` |
| Runtime | `agent.setPolicy(policy)` swaps the active policy; `agent.getPolicy()` reads it. The allowed tool set and the tool schemas sent to the model follow immediately |

`PolicyConfig` is `Partial<AgentPolicy>`. `resolveAgentPolicy(config?)` merges it over `DEFAULT_AGENT_POLICY`, which is `{ id: 'default', allowedTools: 'all' }`. `setPolicy` takes a full `AgentPolicy`, so spread the default when you only change a field: `agent.setPolicy({ ...DEFAULT_AGENT_POLICY, id: 'full-access' })`.

The policy filters the tools the agent already has. It never adds one. A bare agent has no tools, so `allowedTools: 'all'` on it still means no tools.

## AgentPolicy fields

| Field | Default | Role |
|-------|---------|------|
| `id` | `'default'` | Stable policy id. It appears in logs; hosts may use it as their own label |
| `allowedTools` | `'all'` | `'all'` or an allow-list of tool names. A tool outside the list is not sent to the model and is denied if called. Include `load_skill` (or your `skillTool.toolName`) if the agent has skills |
| `hardBlockDeniedTools` | `false` | When true, the loop breakers hard-stop after repeated denied-tool calls instead of only adding a reminder |
| `deniedToolReason` | built-in text | Message returned to the model when it calls a denied tool. The result carries the error code `POLICY_BLOCKED` |
| `errorBreaker` | `'off'` | Same-error circuit breaker: `'off'` (never counted, nothing injected), `'soft'` (after the same error repeats, a `<system_reminder>` notice is added; the history stays provider-valid) or `'hard'` (legacy: marks the loop blocked). Prefer `'soft'` |
| `bufferTextUntilAccepted` | `false` | Hold back `text.delta` events until a text-only reply has passed the response gates |
| `perTurnToolLimits` | none | Cap on successful calls per tool within one user turn, e.g. `{ edit_file: 1 }` |
| `responseGates` | none | Ordered gates evaluated before a text-only reply is accepted |

`resolvePolicyTools(baseTools, policy)` and `resolvePolicyDenied(baseTools, policy)` return the allowed and the denied names for a list of tool names. Anything that is not an explicit list leaves every tool allowed.

## Related loop settings

These are not part of `AgentPolicy`; they have their own builder methods and are all off unless you enable them. See [Agent API](agent-api.md#tool-loop-and-routing).

| Method | What it does |
|--------|--------------|
| `Repair(config)` | Repair instructions appended to failed tool results |
| `SameToolBreaker(config)` / `ProgressTools(...names)` | Notice when the same tool leads several rounds in a row; progress tools reset the streak |
| `MaxToolRounds(n)` / `RepeatCallLimit(n)` | Tool round budget per turn (default 10) and identical-call limit (default 2) |
| `Continuation(...policies)` | Host-defined "should this reply be followed by another round" rules |

## ResponseGate

A gate looks at a text-only reply before it is accepted and either accepts it or asks for a retry with a notice.

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

new AgentBuilder().Provider(provider).ResponseGates(gate).Build();
```

`maxRetries` bounds the retries after a `retry` verdict. When it runs out the reply is accepted, passed through `onExhausted` first when you provide it.

## Continuation

A `ContinuationPolicy` runs after a reply was accepted (gates passed) and decides whether the turn ends or another round runs. The library ships no policy: with none configured, the first tool-less reply ends the turn. See [Agent API](agent-api.md#continuation) for the contract and `chainContinuation`.

## Example: per-turn limit

```ts
new AgentBuilder()
  .Provider(provider)
  .WithPresets('filesystem')
  .PerTurnToolLimits({ edit_file: 1 }) // a second successful edit_file in the same turn is denied
  .Build();
```
