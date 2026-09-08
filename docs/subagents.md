# Subagents

Poyraz can delegate token-heavy **read-only research** to a cheaper child agent with an isolated context. Delegation is **non-blocking**: the parent continues tools and LLM rounds while the child runs in the background (at most **one** active subagent per parent).

## Enable

Prefer the CLI:

```text
/model subagent
/model subagent gpt-4o-mini
/model subagent clear
```

That writes `SUBAGENT_MODEL` to `~/.poyraz/.env` and syncs `delegate_task` on the running agent (no restart). Clearing the model cancels any active background job.

You can also set the env var directly:

```bash
SUBAGENT_MODEL=gpt-4o-mini
```

Any id accepted by `resolveModelProfile` works (provider is inferred the same way as `--model` / `DEFAULT_MODEL`).

If `SUBAGENT_MODEL` is missing or empty, the `delegate_task` tool is **not** offered to the parent agent.

## Behavior

| Concern | Parent | Child |
|---------|--------|-------|
| Model | Session / `DEFAULT_MODEL` | `SUBAGENT_MODEL` |
| Context | Full conversation | Fresh (task brief only) |
| Session | Parent `sessionId` | New UUID (todos/shell isolated) |
| Mode | Usually `agent` | Forced `ask` |
| Tools | Template set including `delegate_task` when configured | `read_file`, `list_dir`, `glob_file_search`, `grep` only |
| Recursion | May call `delegate_task` | `delegate_task` excluded |
| Concurrency | Continues while child runs | Max one job; second call is policy-blocked |

### Background flow

1. `delegate_task` returns immediately with `{ taskId, status: "running", model }` (ack only).
2. The child runs under `SubagentJobManager`; completion is stored as a **pending** notice (context is not mutated from the callback).
3. At each `onBeforeRound`, pending results are injected as a `<system_reminder>` user message.
4. If the parent would return final text while the job is still running, the decision loop waits, injects, and runs one more synthesis round.
5. Parent abort / Ctrl+C cancels the active child. Ending a parent turn normally does **not** cancel the child.

Child token usage is rolled into the parent session totals via `recordExternalUsage`.

Lifecycle events (for UIs): `subagent.task.started|progress|completed|failed|cancelled|injected`, plus `subagent.tool.start|result` for verbose child tool traces. Subscribe with `agent.subscribeSubagentEvents(...)`.

## Tool: `delegate_task`

Preset: `delegation`.

Argument:

```json
{ "task": "Self-contained research brief..." }
```

Use for large searches and multi-file surveys. Do not use for trivial reads, edits, shell, or todos — write a complete brief; the child cannot see the parent chat.

## Programmatic runner

Synchronous child run (tests / scripts):

```ts
import { Agent, runSubagentTask } from 'poyraz';

const result = await runSubagentTask({
  task: 'Find all call sites of resolveModelProfile and summarize.',
  createAgent: (config) => new Agent(config),
});
```

Background job manager (used by `Agent` for `delegate_task`):

```ts
import { SubagentJobManager } from 'poyraz';
```

## Modes

`delegate_task` appears only when:

1. `SUBAGENT_MODEL` is set, and
2. The parent is in **agent** mode (plan / ask / chat allowlists do not include it).

## Related

- [Tools](tools.md)
- [Modes](modes.md)
- [Streaming](streaming.md)
- [Auth and providers](auth-and-providers.md)
