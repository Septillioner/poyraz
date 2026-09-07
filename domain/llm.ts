import type { Content } from '@google/genai';

export interface ChatMessageProviderMeta {
  gemini?: {
    modelContent: Content;
  };
  /** Responses API output items (reasoning, function_call, …) for replay on later turns. */
  openai?: {
    outputItems?: unknown[];
  };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  providerMeta?: ChatMessageProviderMeta;
}
export interface ToolCallFunction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: ToolCallFunction;
}

export interface AgentError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ChatOptions {
  model: string;
  messages: ChatMessage[];
  tools?: any[];
  options?: any;
  promptCacheKey?: string;
  promptCacheRetention?: 'in_memory' | '24h';
  signal?: AbortSignal;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
}

export interface ChatResponse {
  content: string;
  tool_calls?: ToolCall[];
  usage?: TokenUsage;
  providerMeta?: ChatMessageProviderMeta;
}

export interface LLMProvider {
  chat(
    options: ChatOptions,
    onToken?: (token: string) => void,
    onReasoning?: (delta: string) => void
  ): Promise<ChatResponse>;
}
