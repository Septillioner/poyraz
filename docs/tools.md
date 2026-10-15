# Tools

Built-in tools are registered when you import `poyraz`, but an agent gets none until you opt in via presets, includes/excludes, or custom definitions. Without a tool selection the agent is a bare model (no tools). Selecting tools adds nothing to the system message: the library writes no tool instructions, tools go to the provider as schemas only. If the model needs guidance on how to use them, put it in `.SystemPrompt(...)` or `.Rules(...)`.

## Presets

| Preset | Tools |
|--------|-------|
| `filesystem` | `read_file`, `edit_file`, `list_dir`, `glob_file_search`, `delete_file` |
| `shell` | `run_terminal_cmd` |
| `search` | `grep` |

```ts
import { AgentBuilder, openAiProfile } from 'poyraz';

new AgentBuilder()
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem', 'shell', 'search')
  .WithoutTools('delete_file')
  .Build();
```

`DefaultSystemTools({ read, write, execute, search|grep })` maps permission-style flags onto those presets.

Presets and name lists are builder (and template / JSON) input only: `Build()` resolves them into the agent's `tools` map, and `AgentConfig` keeps no `toolPresets` / `includeTools`.

Constant map: `TOOL_PRESETS`.

## Built-in tools

> **Note:** the built-in `fs`, `grep` and `system` tools (`read_file`, `edit_file`, `list_dir`, `glob_file_search`, `delete_file`, `grep`, `run_terminal_cmd`) and their presets are still part of the library. Moving them out is a separate task that has not been done yet. Hosts can register their own tools with `defineTool` instead. `load_skill` is not affected.

### `read_file`

Reads a file (optional `offset` / `limit`). Lines are numbered. Supports common image types (jpeg, png, gif, webp).

### `edit_file`

Create or edit a file (`target_file`, `code_edit`). Use `// ... existing code ...` for unchanged regions when editing. Marked destructive.

### `list_dir`

Lists a directory (`target_directory`). Hides dot-files/directories.

### `glob_file_search`

Glob search (`glob_pattern`). Skips dot-files/directories and `node_modules`.

### `delete_file`

Deletes a file (`target_file`). Destructive.

### `run_terminal_cmd`

Runs a shell command (`command`, `is_background`, optional `explanation`).

- Remembers cwd per `sessionId`.
- Foreground timeout: 30 seconds; use `is_background: true` for long jobs.
- Blocks interactive SSH without `BatchMode=yes` and `sudo` without `-n`.

### `grep`

Ripgrep-backed search (`pattern`, optional `path`, `glob`, `output_mode`, …). Requires `rg` on `PATH`.

### `load_skill`

Not a preset. Present only when the agent has at least one skill (`AddSkill` / `AddSkills`, `agent.setSkills(...)` or a template `skills` array) and the tool is not switched off.

Parameter: `name`. The tool description lists each skill name and description. The result is that skill's `content`. Skill text is not copied into the system message.

Configure it with `SkillTool(...)` (`skillTool` in config / template):

| Field | Effect |
|-------|--------|
| `enabled` | Omitted → on whenever skills exist. `false` hides the tool even when skills are registered |
| `toolName` | Name the model sees. Omitted or blank → `load_skill` |

`WithoutTools(name)` also omits it (for the default name, `WithoutTools('load_skill')` works even with a custom `toolName`). A policy `allowedTools` list must include the tool's name or it stays hidden. Helpers: `resolveSkillToolName(config?)`, `isSkillToolEnabled(skills, config?)`, `LOAD_SKILL_TOOL_NAME`. The context meter counts the tool schema and its results under `skills`, whatever the name. See [Agent API](agent-api.md#system-prompt-rules-and-skills).

## Inspecting the registry

```ts
import { toolRegistry, builtinTools, TOOL_PRESETS } from 'poyraz';

toolRegistry.listNames();
toolRegistry.get('read_file');
toolRegistry.resolveToolSet({ presets: ['filesystem'], exclude: ['delete_file'] });
```

`builtinTools` is a name → definition map of registered built-ins.

`toolRegistry` is the shared registry; built-ins register there when `poyraz` is imported. `createToolRegistry(parent?)` makes an isolated one: lookups fall back to `parent`, writes stay local. Each builder and each agent has its own registry layered over the shared one, and nothing a builder or agent does writes to the shared one:

- `RegisterTool(def)` registers on the **builder's** registry and adds the tool to the agent it builds. Presets and `WithTools(name)` resolve against that registry, so a registered tool can be picked by name.
- `agent.mergeExternalTools(map)` registers on the **agent's** registry (`agent.getToolRegistry()`) and adds the tools to the live tool set (the policy filter applies). It returns the names that replaced an existing tool of the agent and logs a warning for them. `agent.removeExternalTools(prefix?)` removes tools by name prefix (default: the MCP prefix).
- Explicit tools (`RegisterTool`, `AddTool`, `AddTools`) win over a preset or name with the same name.

## Tool results and errors

A tool result is a string, or `{ content, structured?, isError? }`. A failed result is the JSON `{"error":{"code","message","details?"}}`, either returned by the tool (`isError: true`, or an `AgentError`) or produced by the loop:

| Code | When |
|------|------|
| `TOOL_NOT_FOUND` | The model called a tool the agent does not have |
| `VALIDATION_ERROR` | The arguments do not match `inputSchema` (with an `Expected shape` hint when one is known) |
| `MISSING_REQUIRED_ARG` | A required argument named in `ToolExecutionOptions.missingArgNames` is absent (`<tool> requires '<arg>' argument.`) |
| `POLICY_BLOCKED` | Denied by `allowedTools`, over a `perTurnToolLimits` cap, or the same tool+arguments called more than `repeatCallLimit` times |
| `EXECUTION_ERROR` | The tool threw |

Failed results carry no extra text unless [repair](policy.md#repair) is enabled.

`ToolExecutionOptions` (what the loop hands to `executeToolCall(tools, policyGuard, toolCall, context, options?)`; the type is exported from `poyraz`, the function is internal):

| Field | Default | Effect |
|-------|---------|--------|
| `repair` | none (off) | A `RepairOptions` (`enabled`, `maxAttempts`, `resolvers`, `generic`); the loop passes the agent's `repair` config |
| `missingArgNames` | `['command']` | Argument names whose absence is reported as `MISSING_REQUIRED_ARG` instead of `VALIDATION_ERROR`. It is keyed by argument name, not by tool name; `[]` turns it off |

`ToolContext.lastReadFile` (`{ path, lineCount }`) is set after any successful tool whose `structured` result has `edit_ready: true`, a string `target_file` and a numeric `line_count` (the built-in `read_file` returns that shape). It is detected by the result's shape, not by the tool name, and only feeds the opt-in repair texts of `edit_file`.

## Policy filtering

Presets define the **base** set. The active `AgentPolicy` then filters it (`allowedTools`), and `perTurnToolLimits` caps successful calls per turn. See [Agent policy](policy.md).

## Custom tools

See [Custom tools](custom-tools.md).
