import { Ollama } from 'ollama';
import OpenAI from 'openai';
import type { ModelProviderKind } from '../../domain/model-profile.js';
import {
  DEFAULT_GEMINI_API_BASE,
  DEFAULT_GROQ_HOST,
  DEFAULT_OLLAMA_HOST,
  llamaCppApiBase,
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
  supportsReasoningEffort?: boolean;
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
  supported_parameters?: unknown;
}

const REASONING_EFFORT_PARAMETER = 'reasoning_effort';
const OPENAI_LISTED_MODEL_PATTERN = /^(?:gpt-|o[1-9])|codex/i;

function supportsReasoningEffort(parameters: unknown): boolean {
  return Array.isArray(parameters) && parameters.includes(REASONING_EFFORT_PARAMETER);
}

function reasoningEffortFromRow(row: unknown): boolean {
  if (!row || typeof row !== 'object') return false;
  return supportsReasoningEffort((row as { supported_parameters?: unknown }).supported_parameters);
}

function isOpenAiListedModel(id: string): boolean {
  return OPENAI_LISTED_MODEL_PATTERN.test(id);
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
  llamaCppHost?: string;
  llamaCppApiKey?: string;
  openAiApiKey?: string;
  groqApiKey?: string;
  geminiApiKey?: string;
  openRouterApiKey?: string;
}

interface LlamaCppListedModel {
  id?: string;
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

async function listLlamaCppChatModels(host: string, apiKey?: string): Promise<ListedChatModelRow[]> {
  const base = llamaCppApiBase(host);
  const headers: Record<string, string> = {};
  const key = apiKey?.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${base}/models`, { headers });
  if (!res.ok) {
    throw new Error(`llama.cpp models HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data?: LlamaCppListedModel[] };
  const rows: ListedChatModelRow[] = [];
  for (const model of body.data ?? []) {
    const id = model.id?.trim();
    if (!id) continue;
    rows.push({
      provider: 'llamacpp',
      name: id,
      id,
      host,
    });
  }
  return rows;
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
    if (env.llamaCppHost) {
      const localModels = await listLlamaCppChatModels(env.llamaCppHost, env.llamaCppApiKey);
      models.push(...localModels);
    }
  } catch (error: unknown) {
    logger.warn('llama.cpp not available for model listing');
    if (env.llamaCppHost) throw error;
  }

  try {
    if (env.openAiApiKey) {
      const openai = new OpenAI({ apiKey: env.openAiApiKey });
      const remoteModels = await openai.models.list();
      remoteModels.data
        .filter((m) => isOpenAiListedModel(m.id))
        .forEach((m) => {
          models.push({
            provider: 'openai',
            name: m.id,
            id: m.id,
            host: DEFAULT_OPENAI_HOST,
            supportsReasoningEffort: true,
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
      const body = (await res.json()) as { data?: { id: string; supported_parameters?: unknown }[] };
      for (const m of body.data ?? []) {
        models.push({
          provider: 'groq',
          name: m.id,
          id: m.id,
          host: DEFAULT_GROQ_HOST,
          ...(reasoningEffortFromRow(m) ? { supportsReasoningEffort: true } : {}),
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
          ...(reasoningEffortFromRow(m) ? { supportsReasoningEffort: true } : {}),
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
