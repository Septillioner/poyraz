import type { ChatMessage, ChatOptions, ChatResponse, LLMProvider } from '../../domain/llm.js';

export interface MockLLMStep {
  content?: string;
  tool_calls?: ChatResponse['tool_calls'];
  usage?: ChatResponse['usage'];
}

export interface MockLLMCall {
  messages: ChatMessage[];
  options: ChatOptions;
}

export function mockLLM(steps: MockLLMStep[]): LLMProvider & { calls: MockLLMCall[] } {
  const calls: MockLLMCall[] = [];
  let stepIndex = 0;

  return {
    calls,
    async chat(options: ChatOptions): Promise<ChatResponse> {
      calls.push({
        messages: structuredClone(options.messages),
        options: { ...options },
      });

      const step = steps[Math.min(stepIndex, steps.length - 1)];
      stepIndex++;

      return {
        content: step.content ?? '',
        tool_calls: step.tool_calls,
        usage: step.usage ?? {
          promptTokens: 100,
          completionTokens: 20,
          totalTokens: 120,
        },
      };
    },
  };
}

export function toolCall(
  name: string,
  args: Record<string, unknown>,
  id = `call_${name}`
): NonNullable<ChatResponse['tool_calls']>[number] {
  return {
    id,
    type: 'function',
    function: { name, arguments: args },
  };
}

export function containsRepairFor(messages: ChatMessage[], toolName: string): boolean {
  return messages.some(
    (m) =>
      m.role === 'tool' &&
      m.content.includes('REPAIR:') &&
      m.content.toLowerCase().includes(toolName.toLowerCase())
  );
}
