import type { LLMProvider } from '../../domain/llm.js';
import type { ModelProfile } from '../../domain/model-profile.js';
import {
  DEFAULT_GROQ_HOST,
  DEFAULT_OPENROUTER_HOST,
  openRouterDefaultHeaders,
} from '../../domain/model-profile.js';
import { GeminiProvider } from './gemini-provider.js';
import { OllamaProvider, OpenAIProvider } from './providers.js';

export function createLLMProvider(profile: ModelProfile, apiKey?: string): LLMProvider {
  if (profile.provider === 'openrouter' || profile.host.includes('openrouter.ai')) {
    return new OpenAIProvider(
      profile.host || DEFAULT_OPENROUTER_HOST,
      apiKey || '',
      openRouterDefaultHeaders()
    );
  }
  if (profile.provider === 'groq' || profile.host.includes('groq.com')) {
    return new OpenAIProvider(profile.host || DEFAULT_GROQ_HOST, apiKey || '');
  }
  if (
    profile.provider === 'gemini' ||
    profile.host.includes('generativelanguage.googleapis.com')
  ) {
    return new GeminiProvider(apiKey || '');
  }
  if (profile.provider === 'openai' || profile.host.includes('openai.com')) {
    return new OpenAIProvider(profile.host, apiKey || '');
  }
  return new OllamaProvider(profile.host);
}
