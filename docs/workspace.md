# Workspace

Workspace trust, project settings and log-directory selection are host concerns. The library only accepts an optional file-logging config, either per agent or process-wide:

```ts
import { AgentBuilder, configureFileLogging, setActiveWorkspaceRoot } from 'poyraz';

// Per agent (preferred): the agent's own logger and chat debug files.
new AgentBuilder().Provider(provider).FileLogging({ enabled: true, logDir: '/path/to/project/log' }).ChatDebugLog().Build();

// Process-wide, for code that logs through the shared logger outside an agent call:
configureFileLogging({ enabled: true, logDir: '/path/to/project/log' });
setActiveWorkspaceRoot('/path/to/project'); // used by shell tools for cwd resolution
```

Chat debug JSON logs (`ChatDebugLog()`) are written under the agent's log dir, falling back to the process-wide dir. See [Rate limit and logging](rate-limit-and-logging.md#logging).
