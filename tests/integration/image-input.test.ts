import { afterEach, expect, it, vi } from 'vitest';
import { AgentBuilder } from '../../application/agent/agent-builder.js';
import type { ChatMessage, MessageImage } from '../../domain/llm.js';
import { toResponsesInput } from '../../infrastructure/llm/openai-responses.js';
import { toGeminiContents } from '../../infrastructure/llm/gemini-messages.js';
import { OllamaProvider, OpenAIProvider } from '../../infrastructure/llm/providers.js';
import { buildMessageMeta } from '../../application/context/message-category.js';
import { estimateRequest } from '../../application/context/context-report.js';
import { createTokenEstimator } from '../../application/context/token-estimate.js';

const image: MessageImage = { mimeType: 'image/png', data: 'iVBORw0KGgo=' };
const user: ChatMessage = { role: 'user', content: 'Describe this.', images: [image] };
afterEach(() => vi.unstubAllGlobals());

it('keeps image estimates independent of text calibration', () => {
  const estimator = createTokenEstimator();
  const message = { ...user, content: '' };
  const meta = buildMessageMeta(message, new Map(), estimator);
  const estimate = () => estimateRequest({ entries: [{ message, meta }], toolSchemas: [], estimator });
  const before = estimate();
  estimator.calibrate({ chars: 100, realTokens: 100 }, 1);
  expect(estimate()).toEqual(before);
  expect(before.chars).toBe(0);
  expect(before.total).toBe(1536 + estimator.messageOverheadTokens);
});

it('Responses and Gemini preserve image-only inputs and plain text requests', () => {
  expect(toResponsesInput([user]).input).toEqual([{ role: 'user', content: [
    { type: 'input_text', text: 'Describe this.' },
    { type: 'input_image', image_url: `data:image/png;base64,${image.data}`, detail: 'auto' },
  ] }]);
  expect(toResponsesInput([{ ...user, content: '' }]).input[0]).toMatchObject({ content: [{ type: 'input_image' }] });
  expect(toGeminiContents([user]).contents).toEqual([{ role: 'user', parts: [{ text: 'Describe this.' }, { inlineData: image }] }]);
  expect(toGeminiContents([{ ...user, content: '' }]).contents[0].parts).toEqual([{ inlineData: image }]);
  expect(toResponsesInput([{ role: 'user', content: 'Text only' }]).input).toEqual([{ role: 'user', content: 'Text only' }]);
});

it('Chat Completions sends data URLs and Ollama sends raw base64 on the wire', async () => {
  const captured: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body)); captured.push(body);
    return body.stream && body.messages[0].images
      ? new Response(JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n', { headers: { 'content-type': 'application/x-ndjson' } })
      : new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  }));
  await new OpenAIProvider('http://localhost:8080/v1', 'test', undefined, { completionsOnly: true }).chat({ model: 'vision', messages: [user] });
  expect(captured[0].messages[0].content).toEqual([{ type: 'text', text: 'Describe this.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${image.data}` } }]);
  await new OllamaProvider('http://localhost:11434').chat({ model: 'vision', messages: [user] });
  expect(captured[1].messages[0].images).toEqual([image.data]);
});

it('agent history keeps images across follow-ups and history reloads', async () => {
  const requests: ChatMessage[][] = [];
  const provider = { chat: async (options: { messages: ChatMessage[] }) => { requests.push(structuredClone(options.messages)); return { content: 'A blue image.' }; } };
  const agent = new AgentBuilder().Provider(provider).Build();
  await agent.chat('', { images: [image] });
  await agent.chat('What color was it?');
  expect(requests[1][0].images).toEqual([image]);
  const reopened = new AgentBuilder().Provider(provider).Build();
  reopened.loadHistory(agent.getHistory());
  await reopened.chat('Describe it again.');
  expect(requests[2][0].images).toEqual([image]);
  expect(reopened.estimateContext().total).toBeGreaterThanOrEqual(1536);
});
