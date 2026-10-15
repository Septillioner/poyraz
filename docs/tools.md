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

> **Planned removal:** the built-in `fs`, `grep` and `system` tools (`read_file`, `edit_file`, `list_dir`, `glob_file_search`, `delete_file`, `grep`, `run_terminal_cmd`) and their presets are slated for removal from the library. New hosts should register their own tools with `defineTool`. `load_skill` stays.

### `read_file`

Reads a file (optional `offset` / `limit`). Lines are numbered. Supports common image types (jpeg, png, gif, webp).

### `edit_file`

Create or edit a file (`target_file`, `code_edit`). Use `// ... existing code ...` for unchanged regions when editing. Marked destructive.

### `list_dir`

Lists a directory (`target_directory`). Hides dot-files/directories.

### `glob_file_search`

Glob search (`glob_pattern`).

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

Not a preset. Present only when the agent has at least one skill (`AddSkill` / `AddSkills` or a template `skills` array) and the tool is not switched off.

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

`toolRegistry` is the shared registry. Each builder and each agent has its own registry layered over it (`createToolRegistry(parent?)`): `RegisterTool` and `mergeExternalTools` write only to the agent's own, `agent.getToolRegistry()` returns it, and the shared one is never modified by an agent.

## Policy filtering

Presets define the **base** set. The active `AgentPolicy` then filters it (`allowedTools`). See [Agent policy](policy.md).

## Custom tools

See [Custom tools](custom-tools.md).
