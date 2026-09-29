import type { ModelProfile, ProviderApiKeys } from '../../domain/model-profile.js';
import {
  geminiProfile,
  groqProfile,
  ollamaProfile,
  openAiProfile,
  openRouterProfile,
} from '../../domain/model-profile.js';
import type { ListedChatModelRow } from './list-chat-models.js';

export function rowToModelProfile(row: ListedChatModelRow): ModelProfile {
  return {
    model: row.id,
    provider: row.provider,
    host: row.host,
  };
}

export function inferProfileForModel(
  modelId: string,
  keys: ProviderApiKeys,
  ollamaHost?: string
): ModelProfile {
  if (modelId.includes('/') && keys.openrouter) {
    return openRouterProfile(modelId);
  }
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1-')) {
    return openAiProfile(modelId);
  }
  if (modelId.startsWith('gemini-') && keys.gemini) {
    return geminiProfile(modelId);
  }
  if (keys.groq) {
    return groqProfile(modelId);
  }
  return ollamaProfile(modelId, ollamaHost);
}

export function findModelProfile(
  modelId: string,
  models: ListedChatModelRow[]
): ModelProfile | null {
  const exact = models.find((m) => m.id === modelId);
  if (exact) return rowToModelProfile(exact);

  const partial = models.find((m) => m.id.includes(modelId) || m.name.includes(modelId));
  if (partial) return rowToModelProfile(partial);

  return null;
}
