import { GoogleGenAI, type Content, type FunctionCall, type Part } from '@google/genai';
import type { ChatOptions, ChatResponse, LLMProvider, ToolCall, TokenUsage } from '../../domain/llm.js';
import { ChatAbortedError } from '../../shared/chat-aborted.js';
import { logger } from '../../shared/logger.js';
import { buildGeminiRequest, mergeStreamingParts } from './gemini-messages.js';

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = (error as { name?: string }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}

function toTokenUsage(metadata: {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  cachedContentTokenCount?: number;
}): TokenUsage {
  return {
    promptTokens: metadata.promptTokenCount ?? 0,
    completionTokens: metadata.candidatesTokenCount ?? 0,
    totalTokens: metadata.totalTokenCount ?? 0,
    cachedTokens: metadata.cachedContentTokenCount,
  };
}

function functionCallsToToolCalls(calls: FunctionCall[]): ToolCall[] {
  return calls
    .filter((call) => call.name)
    .map((call, index) => ({
      id: call.id || `call_${index}_${call.name}`,
      type: 'function' as const,
      function: {
        name: call.name!,
        arguments: (call.args ?? {}) as Record<string, unknown>,
      },
    }));
}

export class GeminiProvider implements LLMProvider {
  private ai: GoogleGenAI;

  constructor(apiKey: string) {
    this.ai = new GoogleGenAI({ apiKey });
  }

  async chat(options: ChatOptions, onToken?: (token: string) => void): Promise<ChatResponse> {
    const { systemInstruction, contents, tools } = buildGeminiRequest(
      options.messages,
      options.tools
    );

    try {
      const stream = await this.ai.models.generateContentStream({
        model: options.model,
        contents,
        config: {
          systemInstruction,
          tools,
          abortSignal: options.signal,
        },
      });

      let content = '';
      let usage: TokenUsage | undefined;
      let modelParts: Part[] = [];
      const functionCalls = new Map<string, FunctionCall>();

      for await (const chunk of stream) {
        if (options.signal?.aborted) {
          throw new ChatAbortedError();
        }

        if (chunk.usageMetadata) {
          usage = toTokenUsage(chunk.usageMetadata);
        }

        const text = chunk.text;
        if (text) {
          content += text;
          onToken?.(text);
        }

        for (const call of chunk.functionCalls ?? []) {
          if (!call.name) continue;
          const key = call.id || call.name;
          const existing = functionCalls.get(key);
          functionCalls.set(key, {
            ...existing,
            ...call,
            args: {
              ...(existing?.args ?? {}),
              ...(call.args ?? {}),
            },
          });
        }

        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts?.length) {
          modelParts = mergeStreamingParts(modelParts, parts);
        }
      }

      const tool_calls = functionCallsToToolCalls([...functionCalls.values()]);
      const modelContent: Content | undefined =
        modelParts.length > 0 ? { role: 'model', parts: modelParts } : undefined;

      if (!content && tool_calls.length === 0) {
        logger.warn('Gemini model returned an empty response');
      }

      return {
        content,
        tool_calls: tool_calls.length > 0 ? tool_calls : undefined,
        usage,
        providerMeta: modelContent ? { gemini: { modelContent } } : undefined,
      };
    } catch (error: unknown) {
      if (options.signal?.aborted || isAbortError(error)) {
        throw new ChatAbortedError();
      }
      throw error;
    }
  }
}
