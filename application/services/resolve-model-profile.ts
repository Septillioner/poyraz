import type { ModelProfile } from '../../domain/model-profile.js';
import {
  geminiProfile,
  groqProfile,
  ollamaProfile,
  openAiProfile,
  openRouterProfile,
} from '../../domain/model-profile.js';
import { loadSessionPrefs } from './session-prefs.js';
import {
  listAggregatedChatModels,
  listChatModelsEnvFromProcess,
  type ListedChatModelRow,
  type ListChatModelsEnv,
} from './list-chat-models.js';

export interface ResolveModelProfileEnv {
  DEFAULT_MODEL?: string;
  OLLAMA_HOST?: string;
  OPENAI_API_KEY?: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
}

function envRecord(env?: ResolveModelProfileEnv): ResolveModelProfileEnv {
  return env ?? (process.env as ResolveModelProfileEnv);
}

function toListEnv(e: ResolveModelProfileEnv): ListChatModelsEnv {
  return {
    ollamaHost: e.OLLAMA_HOST,
    openAiApiKey: e.OPENAI_API_KEY,
    groqApiKey: e.GROQ_API_KEY,
    geminiApiKey: e.GEMINI_API_KEY,
    openRouterApiKey: e.OPENROUTER_API_KEY,
  };
}

export function rowToModelProfile(row: ListedChatModelRow): ModelProfile {
  return {
    model: row.id,
    provider: row.provider,
    host: row.host,
  };
}

export function inferProfileForModel(
  modelId: string,
  env?: ResolveModelProfileEnv
): ModelProfile {
  const e = envRecord(env);
  if (modelId.includes('/') && e.OPENROUTER_API_KEY) {
    return openRouterProfile(modelId);
  }
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1-')) {
    return openAiProfile(modelId);
  }
  if (modelId.startsWith('gemini-') && e.GEMINI_API_KEY) {
    return geminiProfile(modelId);
  }
  if (e.GROQ_API_KEY) {
    return groqProfile(modelId);
  }
  return ollamaProfile(modelId, e.OLLAMA_HOST);
}

export function resolveModelProfileSync(env?: ResolveModelProfileEnv): ModelProfile {
  const e = envRecord(env);

  if (e.DEFAULT_MODEL) {
    return inferProfileForModel(e.DEFAULT_MODEL, e);
  }

  const prefs = loadSessionPrefs();
  if (prefs.lastModelProfile) {
    return prefs.lastModelProfile;
  }

  if (e.OPENAI_API_KEY) {
    return openAiProfile('gpt-4o');
  }

  if (e.GROQ_API_KEY) {
    return groqProfile('llama-3.3-70b-versatile');
  }

  if (e.GEMINI_API_KEY) {
    return geminiProfile('gemini-2.0-flash');
  }

  if (e.OPENROUTER_API_KEY) {
    return openRouterProfile('openai/gpt-4o-mini');
  }

  return ollamaProfile('llama3.2', e.OLLAMA_HOST);
}

export async function resolveModelProfile(input?: {
  cliModel?: string;
  env?: ResolveModelProfileEnv;
}): Promise<ModelProfile> {
  const e = envRecord(input?.env);
  const listEnv = toListEnv(e);

  if (input?.cliModel) {
    const models = await listAggregatedChatModels(listEnv);
    const exact = models.find((m) => m.id === input.cliModel);
    if (exact) return rowToModelProfile(exact);

    const partial = models.find(
      (m) => m.id.includes(input.cliModel!) || m.name.includes(input.cliModel!)
    );
    if (partial) return rowToModelProfile(partial);

    return inferProfileForModel(input.cliModel, e);
  }

  if (e.DEFAULT_MODEL) {
    const models = await listAggregatedChatModels(listEnv);
    const fromPool = findModelProfile(e.DEFAULT_MODEL, models);
    if (fromPool) return fromPool;
    return inferProfileForModel(e.DEFAULT_MODEL, e);
  }

  const sync = resolveModelProfileSync(e);
  if (sync) return sync;

  const models = await listAggregatedChatModels(listEnv);
  if (models.length > 0) return rowToModelProfile(models[0]);

  return openAiProfile('gpt-4o');
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
