import type { Content, FunctionDeclaration, Part, Tool } from '@google/genai';
import type { ChatMessage } from '../../domain/llm.js';

export interface GeminiRequestPayload {
  systemInstruction?: string;
  contents: Content[];
  tools?: Tool[];
}

function toolResponseBody(content: string): Record<string, unknown> {
  const trimmed = content.trim();
  if (!trimmed) return { output: '' };
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { output: parsed };
    } catch {
      return { output: content };
    }
  }
  return { output: content };
}

function resolveToolName(messages: ChatMessage[], toolCallId?: string): string {
  if (!toolCallId) return 'unknown';
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' || !msg.tool_calls?.length) continue;
    const match = msg.tool_calls.find((tc) => tc.id === toolCallId);
    if (match) return match.function.name;
  }
  return 'unknown';
}

function assistantToModelContent(msg: ChatMessage, allMessages: ChatMessage[]): Content {
  if (msg.providerMeta?.gemini?.modelContent) {
    return {
      ...msg.providerMeta.gemini.modelContent,
      role: 'model',
    };
  }

  const parts: Part[] = [];
  if (msg.content) {
    parts.push({ text: msg.content });
  }

  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      parts.push({
        functionCall: {
          id: tc.id || undefined,
          name: tc.function.name,
          args: tc.function.arguments,
        },
      });
    }
  }

  if (!parts.length) {
    parts.push({ text: '' });
  }

  return { role: 'model', parts };
}

function toolToUserContent(msg: ChatMessage, allMessages: ChatMessage[]): Content {
  const name = resolveToolName(allMessages, msg.tool_call_id);
  return {
    role: 'user',
    parts: [
      {
        functionResponse: {
          id: msg.tool_call_id,
          name,
          response: toolResponseBody(msg.content),
        },
      },
    ],
  };
}

export function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction?: string;
  contents: Content[];
} {
  let systemInstruction: string | undefined;
  const contents: Content[] = [];
  const conversation = messages.filter((msg) => {
    if (msg.role === 'system') {
      if (!systemInstruction) systemInstruction = msg.content;
      return false;
    }
    return true;
  });

  for (const msg of conversation) {
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content }] });
      continue;
    }
    if (msg.role === 'assistant') {
      contents.push(assistantToModelContent(msg, messages));
      continue;
    }
    if (msg.role === 'tool') {
      contents.push(toolToUserContent(msg, messages));
    }
  }

  return { systemInstruction, contents };
}

export function toGeminiTools(openAiTools?: unknown[]): Tool[] | undefined {
  if (!openAiTools?.length) return undefined;

  const functionDeclarations: FunctionDeclaration[] = [];
  for (const tool of openAiTools) {
    const entry = tool as {
      function?: {
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
      };
    };
    if (!entry.function?.name) continue;
    functionDeclarations.push({
      name: entry.function.name,
      description: entry.function.description,
      parametersJsonSchema: entry.function.parameters,
    });
  }

  if (!functionDeclarations.length) return undefined;
  return [{ functionDeclarations }];
}

export function buildGeminiRequest(
  messages: ChatMessage[],
  openAiTools?: unknown[]
): GeminiRequestPayload {
  const { systemInstruction, contents } = toGeminiContents(messages);
  return {
    systemInstruction,
    contents,
    tools: toGeminiTools(openAiTools),
  };
}

export function mergeStreamingParts(accumulated: Part[], incoming: Part[]): Part[] {
  const result = accumulated.map((part) => ({ ...part }));

  for (const part of incoming) {
    if (part.text !== undefined) {
      const last = result[result.length - 1];
      if (
        last?.text !== undefined &&
        last.thought === part.thought &&
        !last.functionCall &&
        !last.functionResponse
      ) {
        last.text = `${last.text || ''}${part.text}`;
        if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature;
      } else {
        result.push({ ...part });
      }
      continue;
    }

    if (part.functionCall) {
      const callId = part.functionCall.id || part.functionCall.name;
      const existingIndex = result.findIndex((entry) => {
        const existingId = entry.functionCall?.id || entry.functionCall?.name;
        return existingId && callId && existingId === callId;
      });
      if (existingIndex >= 0) {
        const existing = result[existingIndex];
        result[existingIndex] = {
          ...part,
          thoughtSignature: part.thoughtSignature ?? existing.thoughtSignature,
          functionCall: {
            ...existing.functionCall,
            ...part.functionCall,
            args: {
              ...(existing.functionCall?.args ?? {}),
              ...(part.functionCall.args ?? {}),
            },
          },
        };
      } else {
        result.push({ ...part });
      }
      continue;
    }

    result.push({ ...part });
  }

  return result;
}
