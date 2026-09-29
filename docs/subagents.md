# Subagents

Delegation is an explicit agent config, not an environment variable.

```ts
import {
  AgentBuilder,
  inferProfileForModel,
  resolveApiKeyForProfile,
  openAiProfile,
} from 'poyraz';

const keys = { openai: process.env.OPENAI_API_KEY };
const parentProfile = openAiProfile('gpt-4o');
const childProfile = inferProfileForModel('gpt-4o-mini', keys);

const agent = new AgentBuilder()
  .WithModelProfile(parentProfile)
  .ApiKey(resolveApiKeyForProfile(parentProfile, keys))
  .WithPresets('filesystem', 'shell', 'search', 'planning', 'delegation')
  .Delegation({
    modelProfile: childProfile,
    apiKey: resolveApiKeyForProfile(childProfile, keys),
  })
  .Build();

// Or at runtime:
agent.setDelegation({
  modelProfile: childProfile,
  apiKey: resolveApiKeyForProfile(childProfile, keys),
});
agent.setDelegation(null); // disables delegate_task; cancels active child
```

## Behavior

- Tool name: `delegate_task`
- One background child per parent
- Child uses a read-only tool set and an isolated session
- Parent receives an immediate ack; findings are injected as a `<system_reminder>` at round boundaries
- Subscribe with `agent.subscribeSubagentEvents` for UI updates across turns

## CLI note

`poyraz-cli` persists a preferred subagent model id in `~/.poyraz/.env` (`SUBAGENT_MODEL`) and calls `setDelegation` at startup / after `/model subagent`. That env handling is not part of the library.
