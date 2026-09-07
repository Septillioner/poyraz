import { Ollama } from 'ollama';
import type { ModelProfile } from '../../domain/model-profile.js';
import { DEFAULT_OLLAMA_HOST } from '../../domain/model-profile.js';
import {
  listAggregatedChatModels,
  type ListChatModelsEnv,
  type ListedChatModelRow,
  type OpenRouterTier,
} from './list-chat-models.js';
import { findModelProfile } from './resolve-model-profile.js';

export interface ModelInfo {
  id: string;
  provider: ModelProfile['provider'];
  host: string;
  displayName?: string;
  tier?: OpenRouterTier;
  contextLength?: number;
  pricing?: { prompt: string; completion: string };
  description?: string;
  ollama?: {
    family?: string;
    parameterSize?: string;
    quantization?: string;
  };
  limitedMetadata?: boolean;
}

function rowToModelInfo(row: ListedChatModelRow): ModelInfo {
  return {
    id: row.id,
    provider: row.provider,
    host: row.host,
    displayName: row.name,
    tier: row.tier,
    contextLength: row.contextLength,
    pricing: row.pricing,
    description: row.description,
  };
}

async function enrichOllamaInfo(info: ModelInfo, env: ListChatModelsEnv): Promise<ModelInfo> {
  try {
    const host = env.ollamaHost || DEFAULT_OLLAMA_HOST;
    const ollama = new Ollama({ host });
    const show = await ollama.show({ model: info.id });
    const details = show.details;
    info.ollama = {
      family: details?.family,
      parameterSize: details?.parameter_size,
      quantization: details?.quantization_level,
    };
    const ctx = show.model_info?.get('llama.context_length');
    if (typeof ctx === 'number') {
      info.contextLength = ctx;
    }
  } catch {
    info.limitedMetadata = true;
  }
  return info;
}

export async function fetchModelInfo(
  profile: ModelProfile,
  env: ListChatModelsEnv
): Promise<ModelInfo> {
  const models = await listAggregatedChatModels(env);
  const row = models.find(
    (m) => m.id === profile.model && m.provider === profile.provider
  );

  const info: ModelInfo = row
    ? rowToModelInfo(row)
    : {
        id: profile.model,
        provider: profile.provider,
        host: profile.host,
        displayName: profile.model,
      };

  if (profile.provider === 'ollama') {
    return enrichOllamaInfo(info, env);
  }

  if (
    profile.provider === 'openai' ||
    profile.provider === 'groq' ||
    profile.provider === 'gemini'
  ) {
    if (!row) info.limitedMetadata = true;
    else if (!info.contextLength && !info.description) info.limitedMetadata = true;
  }

  return info;
}

export async function fetchModelInfoForId(
  modelId: string,
  env: ListChatModelsEnv
): Promise<ModelInfo | null> {
  const models = await listAggregatedChatModels(env);
  const profile = findModelProfile(modelId, models);
  if (!profile) return null;
  return fetchModelInfo(profile, env);
}
