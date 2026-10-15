import type { LLMProvider, RateLimitPolicy } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import {
  DEFAULT_GROQ_HOST,
  DEFAULT_LLAMACPP_HOST,
  DEFAULT_OPENROUTER_HOST,
  LLAMACPP_ANONYMOUS_API_KEY,
  LLAMACPP_MAX_TOOLS,
  llamaCppApiBase,
  openRouterDefaultHeaders,
} from '../../domain/model-profile.js';
import { GeminiProvider } from './gemini-provider.js';
import { OllamaProvider, OpenAIProvider } from './providers.js';

export interface CreateProviderOptions {
  /**
   * Wait-and-retry policy for rate limits, for the OpenAI-compatible providers (OpenAI, OpenRouter,
   * Groq, llama.cpp). Omitted -> no waiting, a 429 is an error at once. Ollama and Gemini never wait.
   */
  rateLimit?: RateLimitPolicy;
}

export function createLLMProvider(
  profile: ModelProfile,
  apiKey?: string,
  options: CreateProviderOptions = {}
): LLMProvider {
  const { rateLimit } = options;
  if (profile.provider === 'llamacpp') {
    return new OpenAIProvider(
      llamaCppApiBase(profile.host || DEFAULT_LLAMACPP_HOST),
      apiKey?.trim() || LLAMACPP_ANONYMOUS_API_KEY,
      undefined,
      { completionsOnly: true, maxTools: LLAMACPP_MAX_TOOLS, rateLimit }
    );
  }
  if (profile.provider === 'openrouter' || profile.host.includes('openrouter.ai')) {
    return new OpenAIProvider(
      profile.host || DEFAULT_OPENROUTER_HOST,
      apiKey || '',
      openRouterDefaultHeaders(),
      { rateLimit }
    );
  }
  if (profile.provider === 'groq' || profile.host.includes('groq.com')) {
    return new OpenAIProvider(profile.host || DEFAULT_GROQ_HOST, apiKey || '', undefined, { rateLimit });
  }
  if (
    profile.provider === 'gemini' ||
    profile.host.includes('generativelanguage.googleapis.com')
  ) {
    return new GeminiProvider(apiKey || '');
  }
  if (profile.provider === 'openai' || profile.host.includes('openai.com')) {
    return new OpenAIProvider(profile.host, apiKey || '', undefined, { rateLimit });
  }
  return new OllamaProvider(profile.host);
}
