import { Ollama } from 'ollama';
import OpenAI from 'openai';
import { ChatAbortedError } from '../../shared/chat-aborted.js';
import { logger } from '../../shared/logger.js';
import type {
  ChatOptions,
  ChatResponse,
  LLMProvider,
  TokenUsage,
  ToolCall,
} from '../../domain/llm.js';
import {
  buildChatResponseFromResponsesOutput,
  buildResponsesReasoning,
  isOpenAiHost,
  isResponsesUnsupportedError,
  mapResponsesUsage,
  requiresOpenAIResponsesApi,
  toResponsesInput,
  toResponsesTools,
} from './openai-responses.js';
import { isRateLimitError, withRateLimitRetry } from './rate-limit.js';
import { sanitizeToolPairing } from './tool-pairing.js';

export class OllamaProvider implements LLMProvider {
  private ollama: Ollama;

  constructor(host: string) {
    this.ollama = new Ollama({ host });
  }

  async chat(options: ChatOptions, onToken?: (token: string) => void): Promise<ChatResponse> {
    const response = await this.ollama.chat({
      model: options.model,
      messages: sanitizeToolPairing(options.messages) as any,
      options: options.options,
      tools: options.tools,
      stream: true,
    });

    let content = '';
    let tool_calls: ToolCall[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for await (const chunk of response) {
      if (options.signal?.aborted) {
        throw new ChatAbortedError();
      }
      if (chunk.message.content) {
        content += chunk.message.content;
        if (onToken) onToken(chunk.message.content);
      }
      if (chunk.message.tool_calls) {
        const normalized = chunk.message.tool_calls.map((item: any) => ({
          id: item.id || '',
          type: 'function' as const,
          function: {
            name: item.function?.name || '',
            arguments: (item.function?.arguments || {}) as Record<string, unknown>,
          },
        }));
        tool_calls.push(...normalized);
      }
      if ((chunk as any).prompt_eval_count !== undefined) promptTokens = (chunk as any).prompt_eval_count;
      if ((chunk as any).eval_count !== undefined) completionTokens = (chunk as any).eval_count;
    }

    const usage: TokenUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };

    return { content, tool_calls: tool_calls.length > 0 ? tool_calls : undefined, usage };
  }
}

export interface OpenAIProviderOptions {
  completionsOnly?: boolean;
  maxTools?: number;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  private baseUrl: string;
  private readonly completionsOnly: boolean;
  private readonly maxTools: number | undefined;
  private readonly responsesUnsupportedModels = new Set<string>();

  constructor(
    baseUrl: string,
    apiKey: string,
    defaultHeaders?: Record<string, string>,
    options?: OpenAIProviderOptions
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.completionsOnly = options?.completionsOnly === true;
    this.maxTools = options?.maxTools;
    this.client = new OpenAI({
      baseURL: this.baseUrl,
      apiKey: apiKey,
      ...(defaultHeaders ? { defaultHeaders } : {}),
    });
  }

  async chat(
    options: ChatOptions,
    onToken?: (token: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<ChatResponse> {
    if (this.shouldTryResponses(options.model)) {
      try {
        return await this.chatViaResponses(options, onToken, onReasoning);
      } catch (error: any) {
        if (!this.shouldFallBackToCompletions(options.model, error)) {
          throw error;
        }
        this.responsesUnsupportedModels.add(this.responsesRouteKey(options.model));
        logger.warn('Responses API unsupported; falling back to Chat Completions', {
          model: options.model,
          message: error?.message,
        });
        if (options.reasoning?.effort) {
          logger.warn('Reasoning effort applies only on the Responses API', {
            model: options.model,
            effort: options.reasoning.effort,
          });
        }
      }
    }

    return this.chatViaCompletions(options, onToken);
  }

  private applyServiceTier(requestBody: Record<string, unknown>, serviceTier?: ChatOptions['serviceTier']): void {
    if (!serviceTier || !isOpenAiHost(this.baseUrl)) return;
    requestBody.service_tier = serviceTier;
  }

  private responsesRouteKey(model: string): string {
    return `${this.baseUrl}\n${model}`;
  }

  private shouldTryResponses(model: string): boolean {
    if (this.completionsOnly) return false;
    if (requiresOpenAIResponsesApi(model, this.baseUrl)) return true;
    return !this.responsesUnsupportedModels.has(this.responsesRouteKey(model));
  }

  private toolsForRequest(tools: ChatOptions['tools']): ChatOptions['tools'] {
    if (!this.maxTools || !tools || tools.length <= this.maxTools) return tools;
    logger.warn('Dropped tools beyond the request limit', {
      limit: this.maxTools,
      total: tools.length,
    });
    return tools.slice(0, this.maxTools);
  }

  private shouldFallBackToCompletions(model: string, error: unknown): boolean {
    if (requiresOpenAIResponsesApi(model, this.baseUrl)) return false;
    if (error instanceof ChatAbortedError) return false;
    const named = error as { name?: string };
    if (named?.name === 'AbortError') return false;
    return isResponsesUnsupportedError(error);
  }

  private async chatViaResponses(
    options: ChatOptions,
    onToken?: (token: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<ChatResponse> {
    return withRateLimitRetry(
      {
        model: options.model,
        signal: options.signal,
        onRateLimit: options.onRateLimit,
      },
      (markEmitted) =>
        this.streamResponses(
          options,
          onToken
            ? (token) => {
                markEmitted();
                onToken(token);
              }
            : undefined,
          onReasoning
            ? (delta) => {
                markEmitted();
                onReasoning(delta);
              }
            : undefined
        )
    );
  }

  private async streamResponses(
    options: ChatOptions,
    onToken?: (token: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<ChatResponse> {
    const { instructions, input } = toResponsesInput(sanitizeToolPairing(options.messages));
    const tools = toResponsesTools(options.tools);

    const requestBody: Record<string, unknown> = {
      model: options.model,
      input,
      stream: true,
      store: false,
      reasoning: buildResponsesReasoning(options.reasoning?.effort),
    };

    if (instructions) {
      requestBody.instructions = instructions;
    }
    if (tools?.length) {
      requestBody.tools = tools;
    }
    if (options.promptCacheKey) {
      requestBody.prompt_cache_key = options.promptCacheKey;
    }
    if (options.promptCacheRetention) {
      requestBody.prompt_cache_retention = options.promptCacheRetention;
    }
    this.applyServiceTier(requestBody, options.serviceTier);

    let stream: any;
    try {
      stream = await this.client.responses.create(requestBody as any, {
        signal: options.signal,
      });
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') {
        throw new ChatAbortedError();
      }
      throw error;
    }

    let content = '';
    let usage: TokenUsage | undefined;
    let output: unknown[] | undefined;

    try {
      for await (const event of stream as any) {
        if (options.signal?.aborted) {
          throw new ChatAbortedError();
        }

        if (
          event?.type === 'response.reasoning_summary_text.delta' &&
          typeof event.delta === 'string'
        ) {
          onReasoning?.(event.delta);
          continue;
        }

        if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          content += event.delta;
          if (onToken) onToken(event.delta);
          continue;
        }

        if (event?.type === 'response.completed' && event.response) {
          output = event.response.output as unknown[] | undefined;
          usage = mapResponsesUsage(event.response.usage);
          if (usage?.cachedTokens && usage.cachedTokens > 0) {
            logger.debug('OpenAI Responses prompt cache hit', {
              cachedTokens: usage.cachedTokens,
              promptCacheKey: options.promptCacheKey,
            });
          }
          if (!content && typeof event.response.output_text === 'string') {
            content = event.response.output_text;
          }
        }
      }
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') {
        throw new ChatAbortedError();
      }
      // Keep the original error for rate limits: its headers carry the window
      // the retry has to wait out.
      if (isRateLimitError(error)) throw error;
      logger.error('Responses stream processing error', { error: error.message });
      const streamError = new Error(error?.message || 'Responses stream failed');
      streamError.name = 'ResponsesStreamProcessingError';
      throw streamError;
    }

    const response = buildChatResponseFromResponsesOutput({ content, output, usage });
    if (!response.content && !response.tool_calls?.length) {
      logger.warn('Model returned an empty Responses API response');
    }
    return response;
  }

  private async chatViaCompletions(
    options: ChatOptions,
    onToken?: (token: string) => void
  ): Promise<ChatResponse> {
    return withRateLimitRetry(
      {
        model: options.model,
        signal: options.signal,
        onRateLimit: options.onRateLimit,
      },
      (markEmitted) =>
        this.streamCompletions(
          options,
          onToken
            ? (token) => {
                markEmitted();
                onToken(token);
              }
            : undefined
        )
    );
  }

  private async streamCompletions(
    options: ChatOptions,
    onToken?: (token: string) => void
  ): Promise<ChatResponse> {
    const requestBody: Record<string, unknown> = {
      model: options.model,
      messages: sanitizeToolPairing(options.messages).map((msg) => ({
        role: msg.role,
        content: msg.content,
        tool_call_id: msg.tool_call_id,
        tool_calls: msg.tool_calls?.map((tc) => ({
          ...tc,
          function: {
            ...tc.function,
            arguments:
              typeof tc.function.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function.arguments),
          },
        })),
      })),
      tools: this.toolsForRequest(options.tools),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (isOpenAiHost(this.baseUrl)) {
      if (options.promptCacheKey) {
        requestBody.prompt_cache_key = options.promptCacheKey;
      }
      if (options.promptCacheRetention) {
        requestBody.prompt_cache_retention = options.promptCacheRetention;
      }
      this.applyServiceTier(requestBody, options.serviceTier);
    }

    let stream: any;
    try {
      stream = await this.client.chat.completions.create(requestBody as any, {
        signal: options.signal,
      });
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') {
        throw new ChatAbortedError();
      }
      throw error;
    }

    let content = '';
    let tool_calls_raw: Array<{
      id?: string;
      type: 'function';
      function: { name: string; arguments: string };
    }> = [];
    let usage: TokenUsage | undefined;

    try {
      for await (const chunk of stream as any) {
        if (options.signal?.aborted) {
          throw new ChatAbortedError();
        }
        if (chunk.usage) {
          const cachedTokens = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
            cachedTokens,
          };
          if (cachedTokens > 0) {
            logger.debug('OpenAI prompt cache hit', {
              cachedTokens,
              promptCacheKey: options.promptCacheKey,
            });
          }
        }

        const delta = chunk.choices && chunk.choices.length > 0 ? chunk.choices[0].delta : null;

        if (delta?.content) {
          content += delta.content;
          if (onToken) onToken(delta.content);
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (!tool_calls_raw[tc.index]) {
              tool_calls_raw[tc.index] = {
                id: tc.id,
                type: 'function',
                function: { name: '', arguments: '' },
              };
            }
            if (tc.function?.name) tool_calls_raw[tc.index].function.name += tc.function.name;
            if (tc.function?.arguments) tool_calls_raw[tc.index].function.arguments += tc.function.arguments;
          }
        }
      }
    } catch (error: any) {
      if (options.signal?.aborted || error?.name === 'AbortError') {
        throw new ChatAbortedError();
      }
      logger.error('Stream processing error', { error: error.message });
      throw error;
    }

    if (!content && tool_calls_raw.length === 0) {
      logger.warn('Model returned an empty response');
    }

    const tool_calls: ToolCall[] = tool_calls_raw
      .filter(Boolean)
      .map((tc) => {
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        } catch (error: any) {
          logger.warn('Invalid tool arguments JSON from provider', {
            toolName: tc.function?.name || 'unknown',
            rawArguments: tc.function?.arguments || '',
            error: error?.message || String(error),
          });
          parsedArgs = {
            _invalid_arguments: true,
            _raw: tc.function.arguments || '',
          };
        }

        return {
          id: tc.id || '',
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: parsedArgs,
          },
        };
      });

    return { content, tool_calls: tool_calls.length > 0 ? tool_calls : undefined, usage };
  }
}
