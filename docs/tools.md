# Tools

Built-in tools are registered when you import `poyraz`, but an agent gets none until you opt in via presets, includes/excludes, or custom definitions. Without a tool selection the agent is a bare model (no tools). Selecting tools does not inject `BASE_PROMPT` into the system message; tools go as provider schemas. Pass coding instructions yourself with `.SystemPrompt(...)` (optionally including exported `BASE_PROMPT`).

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

Constant map: `TOOL_PRESETS`.

## Built-in tools

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

Not a preset. Present only when the agent has at least one skill (`AddSkill` / `AddSkills` or a template `skills` array).

Parameter: `name`. The tool description lists each skill name and description. The result is that skill's `content`. Skill text is not copied into the system message.

`WithoutTools('load_skill')` omits it. A policy `allowedTools` list must include `load_skill` or the tool stays hidden.

## Inspecting the registry

```ts
import { toolRegistry, builtinTools, TOOL_PRESETS } from 'poyraz';

toolRegistry.listNames();
toolRegistry.get('read_file');
toolRegistry.resolveToolSet({ presets: ['filesystem'], exclude: ['delete_file'] });
```

`builtinTools` is a name → definition map of registered built-ins.

## Mode filtering

Presets define the **base** set. The active mode then filters it. See [Modes](modes.md).

## Custom tools

See [Custom tools](custom-tools.md).
