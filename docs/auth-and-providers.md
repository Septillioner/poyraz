# Auth and providers

Poyraz never ships with API keys and does not manage `.env` or `~/.poyraz`. Your app (or `poyraz-cli`) supplies credentials explicitly.

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

Loading and persisting these values (including `~/.poyraz/.env`) belongs in the host app. See `poyraz-cli` docs for the reference CLI approach.

## Model profiles

```ts
import {
  openAiProfile,
  groqProfile,
  geminiProfile,
  openRouterProfile,
  ollamaProfile,
  inferProfileForModel,
} from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const inferred = inferProfileForModel('gpt-4o-mini', keys);
```

Default API hosts:

| Provider | Default host |
|----------|----------------|
| OpenAI | `https://api.openai.com/v1/` |
| Groq | `https://api.groq.com/openai/v1` |
| Gemini | Google Generative Language API |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://127.0.0.1:11434` |

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
};
const models = await listAggregatedChatModels(env);
```

## Custom provider instance

```ts
import { createLLMProvider, openAiProfile } from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const provider = createLLMProvider(profile, apiKey);
```

## Switching models at runtime

```ts
agent.setModelProfile(profile, apiKey);
```
