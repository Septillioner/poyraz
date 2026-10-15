import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatOptions } from '../../domain/llm.js';
import { GeminiProvider } from '../../infrastructure/llm/gemini-provider.js';
import { OllamaProvider, OpenAIProvider } from '../../infrastructure/llm/providers.js';

interface Captured {
  url: string;
  body: Record<string, any>;
}

const tool = {
  type: 'function',
  function: { name: 'lookup', description: 'looks up', parameters: { type: 'object', properties: {} } },
};

/** Replaces `fetch`: records every request body and answers like the endpoint it imitates. */
function fakeNetwork(): Captured[] {
  const seen: Captured[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: any, init?: any) => {
      const url = typeof input === 'string' ? input : (input.url ?? String(input));
      let body: Record<string, any> = {};
      try {
        body = JSON.parse(String(init?.body ?? (typeof input === 'object' ? await input.clone().text() : '')) || '{}');
      } catch {
        body = {};
      }
      seen.push({ url, body });
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { message: 'endpoint not found' } }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.endsWith('/api/chat')) {
        return new Response(
          JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'hi' }, done: true }) + '\n',
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } }
        );
      }
      if (url.includes('GenerateContent') || url.includes('streamGenerateContent')) {
        return new Response(
          'data: ' + JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] } }] }) + '\n\n',
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        );
      }
      const sse =
        'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }) + '\n\n' +
        'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n' +
        'data: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    })
  );
  return seen;
}

async function send(provider: { chat(o: ChatOptions): Promise<unknown> }, options: Partial<ChatOptions>) {
  try {
    await provider.chat({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], ...options });
  } catch {
    // only the request body matters here
  }
}

describe('provider request bodies', () => {
  let seen: Captured[];

  beforeEach(() => {
    seen = fakeNetwork();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('an empty tools array never reaches the wire', () => {
    it.each([
      ['undefined', undefined],
      ['[]', []],
    ])('OpenAI: Responses and Chat Completions omit tools (%s)', async (_label, tools) => {
      await send(new OpenAIProvider('https://api.openai.com/v1', 'k'), { tools });

      const responses = seen.find((r) => r.url.endsWith('/responses'));
      const completions = seen.find((r) => r.url.endsWith('/chat/completions'));
      expect(responses).toBeDefined();
      expect(completions).toBeDefined();
      expect('tools' in responses!.body).toBe(false);
      expect('tools' in completions!.body).toBe(false);
    });

    it('OpenAI-compatible, completions only (llama.cpp style): no tools key', async () => {
      await send(new OpenAIProvider('http://127.0.0.1:8080/v1', 'k', undefined, { completionsOnly: true }), {
        tools: [],
      });
      expect(seen).toHaveLength(1);
      expect('tools' in seen[0].body).toBe(false);
    });

    it('Ollama: no tools key', async () => {
      await send(new OllamaProvider('http://127.0.0.1:11434'), { model: 'llama3', tools: [] });
      const request = seen.find((r) => r.url.endsWith('/api/chat'));
      expect(request).toBeDefined();
      expect('tools' in request!.body).toBe(false);
    });

    it('Gemini: no tools in the request', async () => {
      await send(new GeminiProvider('k'), { model: 'gemini-2.0-flash', tools: [] });
      const request = seen.find((r) => r.url.includes('GenerateContent'));
      expect(request).toBeDefined();
      expect('tools' in request!.body).toBe(false);
    });

    it('a non-empty list is still sent on every path', async () => {
      await send(new OpenAIProvider('https://api.openai.com/v1', 'k'), { tools: [tool] });
      await send(new OllamaProvider('http://127.0.0.1:11434'), { model: 'llama3', tools: [tool] });
      await send(new GeminiProvider('k'), { model: 'gemini-2.0-flash', tools: [tool] });

      expect(seen.find((r) => r.url.endsWith('/responses'))!.body.tools).toHaveLength(1);
      expect(seen.find((r) => r.url.endsWith('/chat/completions'))!.body.tools).toHaveLength(1);
      expect(seen.find((r) => r.url.endsWith('/api/chat'))!.body.tools).toHaveLength(1);
      expect(seen.find((r) => r.url.includes('GenerateContent'))!.body.tools).toHaveLength(1);
    });
  });

  describe('OpenAI Responses reasoning is opt-in', () => {
    it('no reasoning key without Reasoning(...)', async () => {
      await send(new OpenAIProvider('https://api.openai.com/v1', 'k'), {});
      const responses = seen.find((r) => r.url.endsWith('/responses'))!;
      expect('reasoning' in responses.body).toBe(false);
    });

    it('an effort sends reasoning with that effort (and the summary the host streams as reasoning deltas)', async () => {
      await send(new OpenAIProvider('https://api.openai.com/v1', 'k'), { reasoning: { effort: 'low' } });
      const responses = seen.find((r) => r.url.endsWith('/responses'))!;
      expect(responses.body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
    });

    it('reasoning config without an effort sends nothing', async () => {
      await send(new OpenAIProvider('https://api.openai.com/v1', 'k'), { reasoning: {} });
      const responses = seen.find((r) => r.url.endsWith('/responses'))!;
      expect('reasoning' in responses.body).toBe(false);
    });
  });
});
