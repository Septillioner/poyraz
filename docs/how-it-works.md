# How it works

Poyraz is an embeddable agent runtime: LLM interface, tool registry, context management, MCP bridge, and a policy-driven decision loop.

## Layering

| Layer | Responsibility |
|-------|----------------|
| domain | Pure types: LLM messages, `AgentPolicy`, MCP defs, model profiles |
| application | `Agent`, decision loop, system prompt, context metering, summarizer |
| infrastructure | LLM providers (with optional bounded rate-limit waiting), MCP client, chat debug log |
| tools | Built-in tool definitions |
| presentation | Activity tracker helpers |

## What the library does **not** do

- Load or write `.env` or any config under the user's home directory
- Resolve home or project data paths
- Persist MCP server lists, session preferences, or templates to disk
- Add anything of its own to a request: no system text, no tool instructions, no default temperature or `num_ctx`
- Define behavioral modes or personas: a host builds an `AgentPolicy` and system text for what it needs

Those are host concerns. A clean `AgentBuilder()` is a plain text completion; every feature (tools, summarization, repair, breakers, continuation, rate-limit waiting, MCP, logging) is opt-in.

## Runtime flow

1. Host builds an `Agent` with a provider (or model + host), an explicit `apiKey` and whatever optional sections it wants (`Policy`, `Summarization`, `Repair`, ...).
2. MCP is optional: `Mcp({ enabled: true, servers })` connects in `agent.init()`, or the host connects its own manager and calls `agent.mergeExternalTools`.
3. `agent.chat` runs the decision loop: model → tools (policy-filtered) → optional repair text and breakers → optional response gates → optional continuation → context trim or summarization.
4. Streaming events are emitted for UI hosts.

