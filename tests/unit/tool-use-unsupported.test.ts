import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatOptions, LLMProvider } from '../../domain/llm.js';
import { createLLMProvider } from '../../infrastructure/llm/create-provider.js';
import {
  classifyToolUseUnsupported,
  isToolUseUnsupportedError,
  TOOL_USE_UNSUPPORTED_CODE,
  ToolUseUnsupportedError,
  withToolUseClassification,
} from '../../infrastructure/llm/tool-use-unsupported.js';
import * as publicApi from '../../index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const tool = {
  type: 'function' as const,
  function: { name: 'lookup', description: 'looks up', parameters: { type: 'object', properties: {} } },
};
const chatOptions = (model = 'm'): ChatOptions => ({ model, messages: [{ role: 'user', content: 'hi' }], tools: [tool] });

describe('isToolUseUnsupportedError', () => {
  const unsupported = [
    'No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs',
    '404 No endpoints found that support tool use.',
    'registry.ollama.ai/library/gemma:2b does not support tools',
    'gemma3 does not support tools',
    "Unsupported parameter: 'tools' is not supported with this model.",
    'tools is not supported with this model',
    'This model does not support tool use',
    'This model does not support function calling.',
    'The model `x` does not support tool calling',
    'Function calling is not supported for this model',
    'Function calling is not enabled for models/gemini-pro',
    'tool use is not supported by this model',
    'Tool calling is not supported with this model',
    'tools param requires --jinja flag',
    'tool_choice param requires --jinja flag',
    'Cannot use tools: the server was started without --jinja',
    '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
    "model doesn't support tools",
    'Tools are not supported for this endpoint',
    'function calling unsupported for this model',
  ];

  it.each(unsupported)('recognizes: %s', (message) => {
    expect(isToolUseUnsupportedError(new Error(message))).toBe(true);
  });

  it('looks into SDK-style nested errors (error.error.message, OpenRouter metadata.raw, cause)', () => {
    expect(isToolUseUnsupportedError({ status: 404, error: { message: 'No endpoints found that support tool use' } })).toBe(true);
    expect(
      isToolUseUnsupportedError({ message: 'Provider returned error', error: { metadata: { raw: 'm does not support tools' } } })
    ).toBe(true);
    expect(isToolUseUnsupportedError(new Error('failed', { cause: new Error('registry/x does not support tools') }))).toBe(true);
    expect(isToolUseUnsupportedError({ status: 400, response: { data: { error: 'x does not support tools' } } })).toBe(true);
  });

  it('is false for everything else', () => {
    const others = [
      new Error('Rate limit exceeded'),
      new Error('fetch failed'),
      new Error('Invalid API key'),
      new Error('The tool call arguments were invalid JSON'),
      new Error('tool_use_failed: Failed to call a function. Please adjust your prompt.'),
      new Error('Tool "lookup" not found'),
      new Error('model not found'),
      new Error('Request timed out'),
    ];
    for (const error of others) expect(isToolUseUnsupportedError(error)).toBe(false);
    for (const value of [undefined, null, 'does not support tools', 42]) expect(isToolUseUnsupportedError(value)).toBe(false);
    // auth / quota failures are never reported as "no tool support", whatever the text says
    expect(isToolUseUnsupportedError({ status: 401, message: 'x does not support tools' })).toBe(false);
    expect(isToolUseUnsupportedError({ status: 429, message: 'x does not support tools' })).toBe(false);
    const abort = Object.assign(new Error('x does not support tools'), { name: 'AbortError' });
    expect(isToolUseUnsupportedError(abort)).toBe(false);
  });
});

describe('ToolUseUnsupportedError', () => {
  it('keeps the original error as cause, its text as message, and has a stable code', () => {
    const original = Object.assign(new Error('No endpoints found that support tool use'), { status: 404 });
    const error = classifyToolUseUnsupported(original, 'vendor/model')!;
    expect(error).toBeInstanceOf(ToolUseUnsupportedError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ToolUseUnsupportedError');
    expect(error.code).toBe(TOOL_USE_UNSUPPORTED_CODE);
    expect(error.code).toBe('TOOL_USE_UNSUPPORTED');
    expect(error.message).toBe('No endpoints found that support tool use');
    expect(error.cause).toBe(original);
    expect(error.model).toBe('vendor/model');
    expect(error.status).toBe(404);
    expect(isToolUseUnsupportedError(error)).toBe(true);
    expect(classifyToolUseUnsupported(error)).toBe(error);
    expect(classifyToolUseUnsupported(new Error('boom'))).toBeUndefined();
  });

  it('withToolUseClassification converts only matching rejections', async () => {
    const inner: LLMProvider = {
      chat: vi
        .fn()
        .mockRejectedValueOnce(new Error('x does not support tools'))
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce({ content: 'ok' }),
    };
    const provider = withToolUseClassification(inner);
    await expect(provider.chat(chatOptions('mm'))).rejects.toMatchObject({ code: TOOL_USE_UNSUPPORTED_CODE, model: 'mm' });
    await expect(provider.chat(chatOptions())).rejects.toThrow('network down');
    await expect(provider.chat(chatOptions())).resolves.toEqual({ content: 'ok' });
  });

  it('is exported from the package index', () => {
    expect(publicApi.ToolUseUnsupportedError).toBe(ToolUseUnsupportedError);
    expect(publicApi.isToolUseUnsupportedError).toBe(isToolUseUnsupportedError);
    expect(publicApi.TOOL_USE_UNSUPPORTED_CODE).toBe(TOOL_USE_UNSUPPORTED_CODE);
  });
});

describe('built-in providers throw ToolUseUnsupportedError', () => {
  function stubHttp(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))
    );
  }

  it('OpenRouter: 404 "No endpoints found that support tool use"', async () => {
    stubHttp(404, { error: { message: 'No endpoints found that support tool use. To learn more...', code: 404 } });
    const provider = createLLMProvider({ provider: 'openrouter', host: 'https://openrouter.ai/api/v1', model: 'm/x' }, 'k');
    const error = await provider.chat(chatOptions('m/x')).catch((e) => e);
    expect(error).toBeInstanceOf(ToolUseUnsupportedError);
    expect(error.message).toContain('No endpoints found that support tool use');
    expect(error.cause).toBeDefined();
    expect(error.model).toBe('m/x');
  });

  it('OpenAI-compatible: 400 "does not support tools"', async () => {
    stubHttp(400, { error: { message: 'gemma3 does not support tools', type: 'invalid_request_error' } });
    const provider = createLLMProvider({ provider: 'groq', host: 'https://api.groq.com/openai/v1', model: 'gemma3' }, 'k');
    await expect(provider.chat(chatOptions('gemma3'))).rejects.toBeInstanceOf(ToolUseUnsupportedError);
  });

  it('Ollama: 400 "registry.ollama.ai/library/x does not support tools"', async () => {
    stubHttp(400, { error: 'registry.ollama.ai/library/gemma:2b does not support tools' });
    const provider = createLLMProvider({ provider: 'ollama', host: 'http://127.0.0.1:11434', model: 'gemma:2b' });
    await expect(provider.chat(chatOptions('gemma:2b'))).rejects.toBeInstanceOf(ToolUseUnsupportedError);
  });

  it('other failures stay as they were', async () => {
    stubHttp(400, { error: { message: 'Invalid request: messages must not be empty' } });
    const provider = createLLMProvider({ provider: 'groq', host: 'https://api.groq.com/openai/v1', model: 'm' }, 'k');
    const error = await provider.chat(chatOptions()).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ToolUseUnsupportedError);
  });
});
