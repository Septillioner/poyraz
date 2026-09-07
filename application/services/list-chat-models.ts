import { Ollama } from 'ollama';
import OpenAI from 'openai';
import type { ModelProviderKind } from '../../domain/model-profile.js';
import {
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GROQ_HOST,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OPENAI_HOST,
  DEFAULT_OPENROUTER_HOST,
  openRouterDefaultHeaders,
} from '../../domain/model-profile.js';
import { logger } from '../../shared/logger.js';

export type OpenRouterTier = 'free' | 'premium';

export interface ListedChatModelRow {
  provider: ModelProviderKind;
  name: string;
  id: string;
  host: string;
  /** Set only for OpenRouter models. */
  tier?: OpenRouterTier;
  contextLength?: number;
  description?: string;
  pricing?: { prompt: string; completion: string };
}

interface OpenRouterModelPricing {
  prompt?: string;
  completion?: string;
}

interface OpenRouterModelApiRow {
  id: string;
  name?: string;
  pricing?: OpenRouterModelPricing;
  context_length?: number;
  description?: string;
}

export function classifyOpenRouterTier(
  id: string,
  pricing?: OpenRouterModelPricing
): OpenRouterTier {
  if (id.endsWith(':free') || id === 'openrouter/free') return 'free';
  if (pricing?.prompt === '0' && pricing?.completion === '0') return 'free';
  return 'premium';
}

export interface ListChatModelsEnv {
  ollamaHost?: string;
  openAiApiKey?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
  openRouterApiKey?: string;
}

interface GeminiApiModel {
  name: string;
  displayName?: string;
  description?: string;
  inputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

async function listGeminiChatModels(apiKey: string): Promise<ListedChatModelRow[]> {
  const rows: ListedChatModelRow[] = [];
  let pageToken: string | undefined;

  do {
    const url = new URL(`${DEFAULT_GEMINI_API_BASE}/models`);
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), {
      headers: { 'x-goog-api-key': apiKey },
    });
    if (!res.ok) {
      throw new Error(`Gemini models HTTP ${res.status}`);
    }

    const body = (await res.json()) as {
      models?: GeminiApiModel[];
      nextPageToken?: string;
    };

    for (const m of body.models ?? []) {
      if (!m.supportedGenerationMethods?.includes('generateContent')) continue;

      const id = m.name.startsWith('models/') ? m.name.slice('models/'.length) : m.name;
      if (!id.startsWith('gemini-')) continue;

      rows.push({
        provider: 'gemini',
        name: m.displayName?.trim() || id,
        id,
        host: DEFAULT_GEMINI_API_BASE,
        contextLength: m.inputTokenLimit,
        description: m.description,
      });
    }

    pageToken = body.nextPageToken;
  } while (pageToken);

  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export function listChatModelsEnvFromProcess(): ListChatModelsEnv {
  return {
    ollamaHost: process.env.OLLAMA_HOST,
    openAiApiKey: process.env.OPENAI_API_KEY,
    groqApiKey: process.env.GROQ_API_KEY,
    geminiApiKey: process.env.GEMINI_API_KEY,
    openRouterApiKey: process.env.OPENROUTER_API_KEY,
  };
}

export async function listAggregatedChatModels(
  env: ListChatModelsEnv
): Promise<ListedChatModelRow[]> {
  const models: ListedChatModelRow[] = [];
  const ollamaHost = env.ollamaHost || DEFAULT_OLLAMA_HOST;

  try {
    const ollama = new Ollama({ host: ollamaHost });
    const localModels = await ollama.list();
    localModels.models.forEach((m) => {
      models.push({
        provider: 'ollama',
        name: m.name,
        id: m.name,
        host: ollamaHost,
      });
    });
  } catch {
    logger.warn('Ollama not available for model listing');
  }

  try {
    if (env.openAiApiKey) {
      const openai = new OpenAI({ apiKey: env.openAiApiKey });
      const remoteModels = await openai.models.list();
      remoteModels.data
        .filter((m) => m.id.startsWith('gpt-') || m.id.startsWith('o1-'))
        .forEach((m) => {
          models.push({
            provider: 'openai',
            name: m.id,
            id: m.id,
            host: DEFAULT_OPENAI_HOST,
          });
        });
    }
  } catch {
    logger.warn('OpenAI not available for model listing');
  }

  try {
    if (env.groqApiKey) {
      const res = await fetch(`${DEFAULT_GROQ_HOST}/models`, {
        headers: { Authorization: `Bearer ${env.groqApiKey}` },
      });
      if (!res.ok) {
        throw new Error(`Groq models HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: { id: string }[] };
      for (const m of body.data ?? []) {
        models.push({
          provider: 'groq',
          name: m.id,
          id: m.id,
          host: DEFAULT_GROQ_HOST,
        });
      }
    }
  } catch {
    logger.warn('Groq not available for model listing');
  }

  try {
    if (env.geminiApiKey) {
      const geminiModels = await listGeminiChatModels(env.geminiApiKey);
      models.push(...geminiModels);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('Gemini not available for model listing', { error: message });
  }

  try {
    if (env.openRouterApiKey) {
      const headers: Record<string, string> = {
        ...openRouterDefaultHeaders(),
        Authorization: `Bearer ${env.openRouterApiKey}`,
      };
      const res = await fetch(`${DEFAULT_OPENROUTER_HOST}/models`, { headers });
      if (!res.ok) {
        throw new Error(`OpenRouter models HTTP ${res.status}`);
      }
      const body = (await res.json()) as { data?: OpenRouterModelApiRow[] };
      for (const m of body.data ?? []) {
        models.push({
          provider: 'openrouter',
          name: m.name ?? m.id,
          id: m.id,
          host: DEFAULT_OPENROUTER_HOST,
          tier: classifyOpenRouterTier(m.id, m.pricing),
          contextLength: m.context_length,
          description: m.description,
          pricing:
            m.pricing?.prompt !== undefined && m.pricing?.completion !== undefined
              ? { prompt: m.pricing.prompt, completion: m.pricing.completion }
              : undefined,
        });
      }
    }
  } catch {
    logger.warn('OpenRouter not available for model listing');
  }

  return models;
}

export function groupModelsByProvider(
  models: ListedChatModelRow[]
): Map<ModelProviderKind, ListedChatModelRow[]> {
  const groups = new Map<ModelProviderKind, ListedChatModelRow[]>();
  for (const row of models) {
    const list = groups.get(row.provider) ?? [];
    list.push(row);
    groups.set(row.provider, list);
  }
  return groups;
}

export function groupOpenRouterByTier(
  models: ListedChatModelRow[]
): Map<OpenRouterTier, ListedChatModelRow[]> {
  const groups = new Map<OpenRouterTier, ListedChatModelRow[]>([
    ['free', []],
    ['premium', []],
  ]);
  for (const row of models) {
    if (row.provider !== 'openrouter') continue;
    const tier = row.tier ?? 'premium';
    groups.get(tier)?.push(row);
  }
  return groups;
}
