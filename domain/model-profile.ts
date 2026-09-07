export type ModelProviderKind = 'ollama' | 'openai' | 'groq' | 'gemini' | 'openrouter';

export interface ModelProfile {
  model: string;
  provider: ModelProviderKind;
  host: string;
}

export interface ProviderApiKeys {
  openai?: string;
  groq?: string;
  gemini?: string;
  openrouter?: string;
}

export const DEFAULT_OPENAI_HOST = 'https://api.openai.com/v1/';
export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';
export const DEFAULT_GROQ_HOST = 'https://api.groq.com/openai/v1';
export const DEFAULT_GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const DEFAULT_GEMINI_HOST = `${DEFAULT_GEMINI_API_BASE}/openai`;
export const DEFAULT_OPENROUTER_HOST = 'https://openrouter.ai/api/v1';

export function openRouterDefaultHeaders(env?: NodeJS.ProcessEnv): Record<string, string> {
  const e = env ?? process.env;
  return {
    'HTTP-Referer': e.OPENROUTER_HTTP_REFERER || 'https://github.com/poyraz',
    'X-Title': e.OPENROUTER_APP_TITLE || 'Poyraz',
  };
}

export function inferProviderFromHost(host: string): ModelProviderKind {
  if (host.includes('openrouter.ai')) return 'openrouter';
  if (host.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (host.includes('groq.com')) return 'groq';
  if (host.includes('openai.com')) return 'openai';
  return 'ollama';
}

export function resolveApiKeysFromEnv(env?: NodeJS.ProcessEnv): ProviderApiKeys {
  const e = env ?? process.env;
  return {
    openai: e.OPENAI_API_KEY,
    groq: e.GROQ_API_KEY,
    gemini: e.GEMINI_API_KEY,
    openrouter: e.OPENROUTER_API_KEY,
  };
}

export function resolveApiKeyForProfile(
  profile: ModelProfile,
  keys?: ProviderApiKeys
): string {
  const resolved = keys ?? resolveApiKeysFromEnv();
  if (profile.provider === 'openrouter' || profile.host.includes('openrouter.ai')) {
    return resolved.openrouter || '';
  }
  if (profile.provider === 'groq' || profile.host.includes('groq.com')) {
    return resolved.groq || '';
  }
  if (
    profile.provider === 'gemini' ||
    profile.host.includes('generativelanguage.googleapis.com')
  ) {
    return resolved.gemini || '';
  }
  if (profile.provider === 'openai' || profile.host.includes('openai.com')) {
    return resolved.openai || '';
  }
  return '';
}

export function formatProviderLabel(provider: ModelProviderKind): string {
  if (provider === 'openai') return 'OpenAI';
  if (provider === 'groq') return 'Groq';
  if (provider === 'gemini') return 'Gemini';
  if (provider === 'openrouter') return 'OpenRouter';
  return 'Ollama';
}

export function openRouterProfile(model: string): ModelProfile {
  return { model, provider: 'openrouter', host: DEFAULT_OPENROUTER_HOST };
}

export function groqProfile(model: string): ModelProfile {
  return { model, provider: 'groq', host: DEFAULT_GROQ_HOST };
}

export function geminiProfile(model: string): ModelProfile {
  return { model, provider: 'gemini', host: DEFAULT_GEMINI_API_BASE };
}

export function openAiProfile(model: string): ModelProfile {
  return { model, provider: 'openai', host: DEFAULT_OPENAI_HOST };
}

export function ollamaProfile(model: string, host?: string): ModelProfile {
  return {
    model,
    provider: 'ollama',
    host: host || DEFAULT_OLLAMA_HOST,
  };
}

export type PromptHintTier = 'explicit' | 'standard';

const EXPLICIT_HINT_PATTERN =
  /mini|nano|haiku|flash|small|gpt-3\.5|3\.5-turbo|llama-3\.2-1b|llama-3\.2-3b/i;

export function inferPromptHintTier(modelId: string): PromptHintTier {
  return EXPLICIT_HINT_PATTERN.test(modelId) ? 'explicit' : 'standard';
}
