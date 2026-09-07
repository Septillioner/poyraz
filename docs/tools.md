# Tools

Built-in tools are available as soon as you import `poyraz`. You choose which ones an agent gets via presets, includes/excludes, or custom definitions.

## Presets

| Preset | Tools |
|--------|-------|
| `filesystem` | `read_file`, `edit_file`, `list_dir`, `glob_file_search`, `delete_file` |
| `shell` | `run_terminal_cmd` |
| `planning` | `todo_write` |
| `search` | `grep` |

```ts
import { AgentBuilder, openAiProfile } from 'poyraz';

new AgentBuilder()
  .WithModelProfile(openAiProfile('gpt-4o-mini'))
  .WithPresets('filesystem', 'shell', 'search', 'planning')
  .WithoutTools('delete_file')
  .Build();
```

`DefaultSystemTools({ read, write, execute, tasks, search|grep })` maps permission-style flags onto those presets.

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

### `todo_write`

Session todos (`merge`, `todos[]` with `id`, `content`, `status`, optional `blockedReason`).

Statuses: `pending`, `in_progress`, `completed`, `cancelled`, `blocked`. At most one `in_progress`.

### `grep`

Ripgrep-backed search (`pattern`, optional `path`, `glob`, `output_mode`, …). Requires `rg` on `PATH`.

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
