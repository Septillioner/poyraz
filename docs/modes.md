# Modes

Modes let you change how much the agent can do without rebuilding it. The active mode filters the agent’s **base** tool set and adds a mode-specific system directive.

```ts
import {
  AGENT_MODES,
  AGENT_MODE_CYCLE,
  DEFAULT_AGENT_MODE,
  type AgentMode,
} from 'poyraz';

agent.setMode('plan');
const mode: AgentMode = agent.getMode(); // 'plan'
```

Default: `agent` (`DEFAULT_AGENT_MODE`).

Cycle order (`AGENT_MODE_CYCLE`): `agent` → `plan` → `ask` → `chat` → …

Helpers for hosts/CLIs: `isAgentMode`, `resolveAgentMode`, `nextAgentMode`, `resolveModeTools`, `resolveModeDenied`. Full definitions are also on `AGENT_MODES`.

## Mode summary

| Mode | Label | Tools available |
|------|-------|-----------------|
| `agent` | Agent | All tools in the base set |
| `plan` | Plan | `read_file`, `list_dir`, `glob_file_search`, `grep`, `todo_write` |
| `ask` | Ask | `read_file`, `list_dir`, `glob_file_search`, `grep` |
| `chat` | Chat | None |

Denied tools are blocked by policy (the model is told to switch to Agent mode — e.g. `/mode agent` in the CLI).

## Behavioral notes

### agent

- Full tool use until the task is done.
- With an open todo list, the agent is steered not to end the turn while items remain `pending` or `in_progress`.
- File writes should go through `edit_file`, not large code dumps in chat.

### plan

- Explore with read-only tools; record a plan with one `todo_write` per user turn (`merge: false`).
- Cannot implement (`edit_file`, `delete_file`, `run_terminal_cmd` denied).
- Should present a numbered plan and ask the user to switch to Agent mode to apply it.
- After one successful `todo_write` in plan mode, further `todo_write` calls are blocked for that turn.

### ask

- Answer with read-only tools only.
- No edits, shell, or todos.

### chat

- Conversation only; no tools.

## External / MCP tools

`mergeExternalTools` adds tools to the **base** set. They are available in `agent` mode. In `plan` / `ask` / `chat` they are filtered out (built-in allowlists do not include `mcp_*` names).

## Switching in your app

```ts
agent.setMode('ask');
// tools and system prompt refresh automatically

agent.setMode('agent');
await agent.chat('Implement the plan.');
```
