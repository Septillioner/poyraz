# Workspace

When you embed Poyraz in a host (CLI, desktop app, server), users get two kinds of on-disk state: **global** home data and optional **per-project** workspace data.

## Paths

| Path | Role |
|------|------|
| `~/.poyraz/` | Global home (auth, MCP, templates) — [Auth](auth-and-providers.md) |
| `~/.poyraz/data/` | Global templates/config when no project data dir exists |
| `<workspace>/.poyraz/` | Project-local settings and logs |
| `<workspace>/.poyraz/settings.json` | Workspace trust flag |
| `<workspace>/.poyraz/log/` | File logs when trust is enabled |
| `POYRAZ.md` | Optional project notes in the working directory (convention) |

## Detecting a workspace

```ts
import {
  findWorkspaceRoot,
  setActiveWorkspaceRoot,
  writeWorkspaceSettings,
  applyWorkspaceFileLogging,
  resolveWorkspaceTrust,
} from 'poyraz';

const root = findWorkspaceRoot(); // walks up for .git / package.json / data/configs
if (root) {
  setActiveWorkspaceRoot(root);
  // after the user trusts the folder:
  writeWorkspaceSettings(root, { trusted: true });
  applyWorkspaceFileLogging(root, true);
}
```

`findWorkspaceRoot(startDir?)` returns `null` if nothing matches.

## Trust and logging

File logging under `.poyraz/log/` runs only when the workspace is trusted:

```json
{
  "trusted": true,
  "trustedAt": "2026-01-15T12:00:00.000Z"
}
```

Override without a settings file (useful in CI or controlled hosts):

```bash
POYRAZ_TRUST_WORKSPACE=1
```

(`1`, `true`, or `yes`.) Check with `isWorkspaceFileLoggingEnabled()` / `resolveWorkspaceTrust()`.

## Advice for host apps

- Ask before marking a folder trusted; logs may capture paths and command output.
- Tell users to gitignore `.poyraz/` so trust state and logs are not committed.
- Keep API keys in `~/.poyraz/.env`, not in the project tree.
