# Auth and providers

Poyraz never ships with API keys and does not manage `.env` files or any config directory. Your app supplies credentials explicitly.

## Passing keys

```ts
import {
  AgentBuilder,
  openAiProfile,
  resolveApiKeyForProfile,
  type ProviderApiKeys,
} from 'poyraz';

const keys: ProviderApiKeys = {
  openai: process.env.OPENAI_API_KEY,
  groq: process.env.GROQ_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  openrouter: process.env.OPENROUTER_API_KEY,
  llamacpp: process.env.LLAMACPP_API_KEY, // optional; llama.cpp falls back to an anonymous key
};

const profile = openAiProfile('gpt-4o-mini');
const apiKey = resolveApiKeyForProfile(profile, keys);

const agent = new AgentBuilder()
  .WithModelProfile(profile)
  .ApiKey(apiKey)
  .Build();
```

`resolveApiKeyForProfile(profile, keys)` requires an explicit `ProviderApiKeys` object — it does not read `process.env`.

## Provider env key names (convention)

| Provider | Environment variable | Secret |
|----------|----------------------|--------|
| OpenAI | `OPENAI_API_KEY` | yes |
| Groq | `GROQ_API_KEY` | yes |
| Gemini | `GEMINI_API_KEY` | yes |
| OpenRouter | `OPENROUTER_API_KEY` | yes |
| Ollama | `OLLAMA_HOST` | no (host URL) |
| llama.cpp | `LLAMACPP_HOST` (+ optional key) | host URL; the key is optional |

These names are a convention only: the library never reads `process.env`. Loading and persisting the values belongs in the host app.

## Model profiles

```ts
import {
  openAiProfile,
  groqProfile,
  geminiProfile,
  openRouterProfile,
  ollamaProfile,
  llamaCppProfile,
  inferProfileForModel,
} from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const inferred = inferProfileForModel('gpt-4o-mini', keys);
```

`inferProfileForModel` chooses among OpenRouter, OpenAI, Gemini, Groq and Ollama; it never returns llama.cpp, so build that profile yourself.

Default API hosts:

| Provider | Default host |
|----------|----------------|
| OpenAI | `https://api.openai.com/v1/` |
| Groq | `https://api.groq.com/openai/v1` |
| Gemini | Google Generative Language API |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://127.0.0.1:11434` |
| llama.cpp | `http://127.0.0.1:8080` (the OpenAI-compatible `/v1` suffix is added for you) |

### llama.cpp

`llamaCppProfile(model, host?)` describes a llama.cpp server (`llama-server`). It speaks the OpenAI-compatible API through `OpenAIProvider` in completions-only mode, with an anonymous API key (`LLAMACPP_ANONYMOUS_API_KEY`) unless you pass one, and at most `LLAMACPP_MAX_TOOLS` (10) tool schemas per request. `llamaCppApiBase(host)` returns the `/v1` base.

A host URL alone cannot identify llama.cpp (`inferProviderFromHost` returns `'ollama'` for unknown hosts), so create the provider from the profile and inject it:

```ts
import { AgentBuilder, createLLMProvider, llamaCppProfile } from 'poyraz';

const profile = llamaCppProfile('qwen2.5-7b-instruct', process.env.LLAMACPP_HOST);
const agent = new AgentBuilder()
  .Provider(createLLMProvider(profile))
  .Model(profile.model)
  .Build();
```

OpenRouter app headers: `openRouterDefaultHeaders({ referer?, title? })`.

## Listing models

```ts
import { listAggregatedChatModels, type ListChatModelsEnv } from 'poyraz';

const env: ListChatModelsEnv = {
  openAiApiKey: keys.openai,
  groqApiKey: keys.groq,
  geminiApiKey: keys.gemini,
  openRouterApiKey: keys.openrouter,
  ollamaHost: process.env.OLLAMA_HOST,
  llamaCppHost: process.env.LLAMACPP_HOST, // listed only when set; a failing llama.cpp server throws
  llamaCppApiKey: process.env.LLAMACPP_API_KEY,
};
const models = await listAggregatedChatModels(env);
```

Ollama is listed unless `includeOllama: false`. A provider without a key (or host, for llama.cpp) is skipped. Helpers: `groupModelsByProvider`, `groupOpenRouterByTier`, `classifyOpenRouterTier`, `findModelProfile(modelId, models)`, `rowToModelProfile(row)`.

## Model info

`fetchModelInfo(profile, env)` returns a `ModelInfo` for one profile, built from the same listing (`env` is the `ListChatModelsEnv` above): `id`, `provider`, `host`, `displayName?`, `tier?` (OpenRouter), `contextLength?`, `pricing?`, `description?`, and for Ollama `ollama: { family, parameterSize, quantization }` read with `ollama show`. `limitedMetadata: true` means the provider told us little (for example a model missing from the listing). `fetchModelInfoForId(modelId, env)` resolves the profile from the id first and returns `null` when no listed model matches.

```ts
import { fetchModelInfo, ollamaProfile } from 'poyraz';

const info = await fetchModelInfo(ollamaProfile('llama3.2'), { ollamaHost: process.env.OLLAMA_HOST });
console.log(info.contextLength, info.ollama?.parameterSize);
```

## Custom provider instance

```ts
import { createLLMProvider, openAiProfile } from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const provider = createLLMProvider(profile, apiKey);

// Optional third argument: bounded wait-and-retry on 429 for the OpenAI-compatible providers
const patient = createLLMProvider(profile, apiKey, { rateLimit: { enabled: true, maxWaits: 3 } });
```

Pass it with `.Provider(provider)`; the builder then needs no model or host. `ChatOptions.model` is optional, so a custom `LLMProvider` may receive requests without a `model` when you never call `Model(...)`; the built-in OpenAI-compatible providers then leave it out of the request and the endpoint's own default applies. Ollama and Gemini never wait on rate limits. `.RateLimit(...)` on the builder also works with an injected provider: the agent hands the policy to it on every call, and providers that implement waiting (`OpenAIProvider`) honor it.

## Switching models at runtime

```ts
agent.setModelProfile(profile, apiKey);
```
