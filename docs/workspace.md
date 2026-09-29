# Workspace

Workspace trust, project `.poyraz/` settings, and log-directory selection are host concerns. The library only accepts an optional file-logging config:

```ts
import { configureFileLogging, setActiveWorkspaceRoot } from 'poyraz';

// Host decides trust + path:
configureFileLogging({ enabled: true, logDir: '/path/to/project/.poyraz/log' });
setActiveWorkspaceRoot('/path/to/project'); // used by shell tools for cwd resolution
```

Chat debug JSON logs are written under the configured log dir when file logging is enabled.

For the reference trust prompt and `POYRAZ_TRUST_WORKSPACE` override, see `poyraz-cli`.
