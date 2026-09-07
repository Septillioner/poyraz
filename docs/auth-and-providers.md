# Auth and providers

Poyraz never ships with API keys. Your app supplies credentials via the environment, `~/.poyraz/.env`, and optional project `.env` files.

## Provider env keys

| Provider | Environment variable | Secret |
|----------|----------------------|--------|
| OpenAI | `OPENAI_API_KEY` | yes |
| Groq | `GROQ_API_KEY` | yes |
| Gemini | `GEMINI_API_KEY` | yes |
| OpenRouter | `OPENROUTER_API_KEY` | yes |
| Ollama | `OLLAMA_HOST` | no (host URL) |

## Home directory

```text
~/.poyraz/
  .env          # auth and other env vars
  mcp.json      # MCP servers — see mcp.md
  data/
    configs/
      templates/  # agent templates
```

Typical startup:

```ts
import { ensurePoyrazHome, loadAllEnv, maskSecret } from 'poyraz';

ensurePoyrazHome();
loadAllEnv(); // loads ~/.poyraz/.env, then project .env files up the tree
```

Use `maskSecret` when showing keys in a UI. Related helpers: `resolvePoyrazHomeDir`, `resolvePoyrazEnvPath`, `setEnvVar`, `unsetEnvVar`, `readPoyrazAuthValues`.

## Model profiles

```ts
import {
  openAiProfile,
  groqProfile,
  geminiProfile,
  openRouterProfile,
  ollamaProfile,
  resolveApiKeyForProfile,
} from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const apiKey = resolveApiKeyForProfile(profile); // from env
```

Default API hosts:

| Provider | Default host |
|----------|----------------|
| OpenAI | `https://api.openai.com/v1/` |
| Groq | `https://api.groq.com/openai/v1` |
| Gemini | Google Generative Language API |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Ollama | `http://127.0.0.1:11434` |

OpenRouter app headers can be overridden with `OPENROUTER_HTTP_REFERER` and `OPENROUTER_APP_TITLE`.

## Picking a model by id

```ts
import { inferProfileForModel, listAggregatedChatModels } from 'poyraz';

const profile = inferProfileForModel('gpt-4o-mini');
// listAggregatedChatModels() — list models from providers you have keys for
```

Also available: `resolveModelProfile` / `resolveModelProfileSync`.

## Custom provider instance

Most apps use `WithModelProfile` and let the agent create the provider. If you need control:

```ts
import { createLLMProvider, openAiProfile, resolveApiKeyForProfile } from 'poyraz';

const profile = openAiProfile('gpt-4o-mini');
const provider = createLLMProvider(profile, resolveApiKeyForProfile(profile));
```
