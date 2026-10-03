# How it works

Poyraz is an embeddable agent runtime: LLM interface, tool registry, context management, MCP bridge, and a policy-driven decision loop.

## Layering

| Layer | Responsibility |
|-------|----------------|
| domain | Pure types: tasks, LLM messages, `AgentPolicy`, `TodoStore`, MCP defs, model profiles |
| application | `Agent`, decision loop, prompts, summarizer |
| infrastructure | LLM providers, in-memory todo store, MCP client, chat debug log |
| tools | Built-in tool definitions |
| presentation | Todo table / activity tracker helpers |

## What the library does **not** do

- Load or write `.env` / `~/.poyraz`
- Resolve home or project `data/` paths
- Persist MCP server lists, session prefs, or templates to disk
- Define CLI modes (`agent` / `plan` / `ask` / `chat`) — hosts build `AgentPolicy` values

Those belong in `poyraz-cli` (or your own host).

## Runtime flow

1. Host builds an `Agent` with explicit `apiKey` and optional `TodoStore` and `AgentPolicy`.
2. Host may call `mcpClientManager.connectAll(servers)` and `agent.mergeExternalTools`.
3. `agent.chat` runs the decision loop: model → tools (policy-filtered) → optional response gates → context summarization.
4. Streaming events are emitted for UI hosts.

## Persistence injection

```ts
agent // uses createInMemoryTodoStore() by default
new AgentBuilder().TodoStore(myFileBackedStore)
```
