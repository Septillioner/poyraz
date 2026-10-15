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

`PolicyConfig` is `Partial<AgentPolicy>`. `resolveAgentPolicy(config?)` merges it over `DEFAULT_AGENT_POLICY`, which is `{ id: 'default', allowedTools: 'all' }`; a field set to `undefined` counts as "not set" and never wipes a default. `setPolicy` takes a full `AgentPolicy`, so spread the default when you only change a field: `agent.setPolicy({ ...DEFAULT_AGENT_POLICY, id: 'full-access' })`.

The policy filters the tools the agent already has. It never adds one. A bare agent has no tools, so `allowedTools: 'all'` on it still means no tools.

## AgentPolicy fields

| Field | Default | Role |
|-------|---------|------|
| `id` | `'default'` | Stable policy id. It appears in logs; hosts may use it as their own label |
| `allowedTools` | `'all'` | `'all'` or an allow-list of tool names. A tool outside the list is not sent to the model and is denied if called. Include `load_skill` (or your `skillTool.toolName`) if the agent has skills |
| `hardBlockDeniedTools` | `false` | Opt-in for the hard path of the loop breakers. When true, a tripped breaker takes the hard path (the error breaker in `'hard'` mode, or the [same-tool breaker](#related-loop-settings)): it adds a `NOTICE` user message and drops the `tool_calls` of the following replies, so the turn ends in text. When false, a tripped breaker only adds a `<system_reminder>` and the loop goes on |
| `deniedToolReason` | built-in text | Message returned to the model when it calls a denied tool. The result carries the error code `POLICY_BLOCKED` |
| `errorBreaker` | `'off'` | Same-error circuit breaker: `'off'` (never counted, nothing injected), `'soft'` (after the same error repeats, a `<system_reminder>` notice is added; the history stays provider-valid) or `'hard'` (legacy: only takes the hard path together with `hardBlockDeniedTools: true`, otherwise it behaves like `'soft'`). The streak is the same tool, error code and message twice in a row. Prefer `'soft'` |
| `bufferTextUntilAccepted` | `false` | Hold back `text.delta` events until a text-only reply has passed the response gates |
| `perTurnToolLimits` | none | Cap on successful calls per tool within one user turn, e.g. `{ edit_file: 1 }`. Further calls get a `POLICY_BLOCKED` result; the counters reset at the start of every `chat()` |
| `responseGates` | none | Ordered gates evaluated before a text-only reply is accepted (see [ResponseGate](#responsegate)). Code only: not part of `AgentTemplate` / JSON |

`resolvePolicyTools(baseTools, policy)` and `resolvePolicyDenied(baseTools, policy)` return the allowed and the denied names for a list of tool names. Anything that is not an explicit list leaves every tool allowed.

## Related loop settings

These are not part of `AgentPolicy`; they have their own builder methods (and `AgentConfig` / template fields) and are all off unless you enable them. See [Agent API](agent-api.md#tool-loop-and-routing).

| Method | What it does |
|--------|--------------|
| `Repair(config \| boolean = true)` | Repair text appended to failed tool results. Off by default; see [Repair](#repair) |
| `SameToolBreaker({ enabled, limit })` | Off by default. After `limit` (default 3) consecutive rounds led by the same tool, a notice is injected: a `<system_reminder>` normally, a hard stop with `hardBlockDeniedTools: true` |
| `ProgressTools(...names)` | Default: none. A round in which one of these tools succeeded, without leading the round, resets the same-tool streak. A failed call is not progress |
| `MaxToolRounds(n)` / `RepeatCallLimit(n)` | Tool round budget per turn (default 10) and identical tool+args limit (default 2). Precedence: top-level value > `RoutingPolicy({ maxToolRounds, repeatCallLimit })` > `options.max_tool_rounds` / `options.repeat_call_limit` |
| `Continuation(...policies)` | Host-defined "should this reply be followed by another round" rules; see [Continuation](#continuation) |

The library has no hard-coded progress tools and no module-level switches: every breaker is read from the config of the agent.

## Repair

With repair on, a failed tool result (validation error, unknown tool, policy block, execution error, repeated-call block) gets a `REPAIR: ...` text appended after the JSON error. With it off (the default) the result is the plain error and carries no `REPAIR` text; an identical failing call is then bounded by `repeatCallLimit` alone.

```ts
import { AgentBuilder, builtinRepairResolvers } from 'poyraz';
import type { RepairResolver } from 'poyraz';

const orderLookup: RepairResolver = ({ toolName, error, args }) =>
  error.code === 'EXECUTION_ERROR'
    ? `REPAIR: ${toolName} failed for order ${String(args.orderId)}. Check the id and retry once.`
    : undefined; // undefined -> the generic text

new AgentBuilder()
  .Provider(provider)
  .Repair({
    enabled: true,
    maxAttempts: 2,                                  // texts per identical tool call signature (default 3)
    resolvers: { ...builtinRepairResolvers, order_lookup: orderLookup }, // tool name -> its own text; the spread opts in to the built-in fs/shell/grep texts
    generic: ({ toolName, error }) => `REPAIR: ${toolName} failed (${error.code}). Try again with fixed arguments.`,
  })
  .Build();
```

- `RepairConfig` / `RepairOptions` fields: `enabled`, `maxAttempts`, `resolvers`, `generic`. `resolvers` and `generic` are code only; `FromJSON` keeps only function values.
- The resolver gets a `RepairInput`: `{ toolName, error, args, context }` and returns a string, or `undefined` to fall back to `generic`, then to the library's neutral text (`REPAIR: <tool> failed (<code>). Fix the arguments and retry.`, plus an example shape when one is known; a policy block gets "blocked by policy, respond in plain text").
- Once `maxAttempts` texts were given for an identical call signature, later failures carry none and the repeated-call limit applies.
- `builtinRepairResolvers` holds the specific texts of `edit_file`, `run_terminal_cmd` and `grep`. They are opt-in (`resolvers: builtinRepairResolvers`, or spread it and add your own); nothing applies them by default. They step aside for policy blocks.
- The library mentions no mode or persona in any repair text. If the model should know why a tool is blocked, set `deniedToolReason` or say it in the system prompt.

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

Gates run in order on every tool-less reply. `evaluate` gets `{ content, succeededTools }` (the tools that succeeded this turn). A `retry` verdict appends `notice` as a `user` message and runs another round; the retry budget `maxRetries` is counted per gate for the whole turn. When it runs out the reply is accepted, or, when you provide `onExhausted`, replaced by its result (that sanitized reply ends the turn and is not offered to a [continuation policy](#continuation)). With `bufferTextUntilAccepted`, `text.delta` events of a reply are held back until its gates accepted it.

## Continuation

A `ContinuationPolicy` runs after a reply was accepted (tool-less, all response gates passed) and decides whether the turn ends or another round runs. The library ships no policy: with none configured, the first tool-less reply ends the turn.

```ts
import { AgentBuilder, chainContinuation } from 'poyraz';
import type { ContinuationPolicy } from 'poyraz';

const untilDone: ContinuationPolicy = {
  maxContinuations: 3, // hard cap per turn, enforced by the library
  async evaluate({ content, remaining, continuations, round, succeededTools, usage, messages, sessionId, signal }) {
    if (signal?.aborted) return { kind: 'stop', reason: 'not-listening' };
    if (content.includes('DONE')) return { kind: 'stop' };
    if (remaining === 0) return { kind: 'stop', reason: 'handoff', data: { lastReply: content } };
    return { kind: 'continue', notice: 'Continue until you write DONE.' }; // appended as a user message
  },
};

const agent = new AgentBuilder().Provider(provider).Continuation(untilDone).Build();
const { content, continuation } = await agent.chat('Do the task.');
// continuation: { continuations: number; reason?: string; data?: unknown }
```

- `evaluate(context)` returns a `ContinuationDecision` (or a promise of one) and is awaited. The `ContinuationContext` carries `content`, `round` (1-based), `continuations` so far this turn, `remaining` (against this policy's `maxContinuations`, `undefined` without a cap), `succeededTools`, `usage` of the request that produced the reply, a read-only `messages` snapshot, `sessionId` (`agent.setSessionId`) and the turn's `signal`.
- `{ kind: 'continue', notice }` appends `notice` as a `user` message and runs another round (an empty notice ends the turn instead). `{ kind: 'stop', reason?, data? }` ends it and hands `reason` / `data` back on the chat result.
- `maxContinuations` is a hard cap: a `continue` beyond it (including `maxContinuations: 0`) becomes a stop with `reason: 'max-continuations'`. `remaining === 0` is your last chance to hand leftover work back. `maxToolRounds` still bounds the turn.
- Several policies: `Continuation(a, b)` chains them with `chainContinuation(a, b)`. They are asked in order and the first `continue` wins; if none continues, the first stop that carries a reason or data is the result. Each member sees its own `remaining`, a member beyond its own cap counts as stopped, and the chain's cap is the largest member cap (uncapped if any member is). Calling `Continuation(...)` again replaces the previous policies.
- The policy keeps no library-managed state: the counts arrive in the context, so one object serves many turns and sessions.
- Abort: if the turn's signal fires while `evaluate` runs, `chat()` rejects with `ChatAbortedError` even if the policy decided to continue; an error thrown by `evaluate` rejects `chat()` as well (as `ChatAbortedError` when the abort caused it).
- `chat()` returns `continuation` only when a policy is configured. A turn ended by the tool round limit, or by a gate's `onExhausted`, reports `{ continuations }` without a reason.
- JSON / templates: `FromJSON` accepts a policy object (or an array of them) that has an `evaluate` function; plain JSON cannot carry one, so it is a code-level option.

## Example: per-turn limit

```ts
new AgentBuilder()
  .Provider(provider)
  .WithPresets('filesystem')
  .PerTurnToolLimits({ edit_file: 1 }) // a second successful edit_file in the same turn is denied
  .Build();
```
