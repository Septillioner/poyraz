// Manual end-to-end check: a fake OpenAI endpoint that answers 429 first and a
// real stream afterwards. Run with: npx tsx scripts/verify-rate-limit.ts
import http from 'node:http';
import { OpenAIProvider } from '../infrastructure/llm/providers.js';
import { ChatAbortedError } from '../shared/chat-aborted.js';
import type { RateLimitNotice } from '../domain/llm.js';

const MODEL = 'gpt-5';
const TPM_MESSAGE =
  'Rate limit reached for gpt-5 in organization org-1 on tokens per min (TPM): Limit 10000, Requested 15000.';

function completionsStream(): string {
  const chunks = [
    { id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Merhaba' } }] },
    { id: 'c1', choices: [{ index: 0, delta: { content: ' dunya' } }] },
    {
      id: 'c1',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
    },
  ];
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function responsesStream(): string {
  const events = [
    { type: 'response.output_text.delta', delta: 'Merhaba' },
    { type: 'response.output_text.delta', delta: ' dunya' },
    {
      type: 'response.completed',
      response: {
        output: [{ type: 'message', role: 'assistant', content: 'Merhaba dunya' }],
        usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
      },
    },
  ];
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

/** Answers 429 while `rejectFirst` requests have not been served yet. */
function startFakeOpenAI(rejectFirst: number, path: '/chat/completions' | '/responses') {
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    if (state.requests <= rejectFirst) {
      res.writeHead(429, {
        'content-type': 'application/json',
        'x-ratelimit-reset-tokens': '1s',
        'x-ratelimit-reset-requests': '20ms',
      });
      res.end(JSON.stringify({ error: { message: TPM_MESSAGE, type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(path === '/chat/completions' ? completionsStream() : responsesStream());
  });
  return new Promise<{ state: typeof state; url: string; close: () => Promise<void> }>(
    (resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as { port: number };
        resolve({
          state,
          url: `http://127.0.0.1:${port}/v1`,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    }
  );
}

async function survivesRateLimit(
  path: '/chat/completions' | '/responses',
  completionsOnly: boolean
): Promise<void> {
  // The SDK burns two retries of its own on a 429 before it surfaces the error.
  const fake = await startFakeOpenAI(3, path);
  const notices: RateLimitNotice[] = [];
  const tokens: string[] = [];
  const started = Date.now();

  try {
    const provider = new OpenAIProvider(fake.url, 'test-key', undefined, { completionsOnly });
    const response = await provider.chat(
      { model: MODEL, messages: [{ role: 'user', content: 'merhaba' }], onRateLimit: (n) => notices.push(n) },
      (token) => tokens.push(token)
    );

    const wait = notices.find((notice) => notice.kind === 'wait') as
      | Extract<RateLimitNotice, { kind: 'wait' }>
      | undefined;

    console.log(`\n[${path}] survived the rate limit`);
    console.log(`  requests to provider : ${fake.state.requests}`);
    console.log(`  waited               : ${Date.now() - started} ms`);
    console.log(`  wait source/reason   : ${wait?.source} / ${wait?.reason} / ${wait?.delayMs} ms`);
    console.log(`  notices              : ${notices.map((n) => n.kind).join(', ')}`);
    console.log(`  streamed tokens      : ${JSON.stringify(tokens.join(''))}`);
    console.log(`  final content        : ${JSON.stringify(response.content)}`);

    if (response.content !== 'Merhaba dunya') throw new Error('stream was not replayed after the retry');
    if (!wait || wait.source !== 'header') throw new Error('provider suggestion was not used');
    if (!notices.some((n) => n.kind === 'resumed')) throw new Error('retry never resumed');
    if (fake.state.requests !== 4) throw new Error(`unexpected request count ${fake.state.requests}`);
  } finally {
    await fake.close();
  }
}

async function stopsWhenAborted(): Promise<void> {
  const fake = await startFakeOpenAI(Number.MAX_SAFE_INTEGER, '/chat/completions');
  const controller = new AbortController();

  try {
    const provider = new OpenAIProvider(fake.url, 'test-key', undefined, { completionsOnly: true });
    const pending = provider.chat(
      {
        model: MODEL,
        messages: [{ role: 'user', content: 'merhaba' }],
        signal: controller.signal,
        onRateLimit: () => controller.abort(),
      }
    );

    await pending.then(
      () => {
        throw new Error('aborted turn resolved instead of stopping');
      },
      (error) => {
        const stopped = error instanceof ChatAbortedError;
        console.log(`\n[abort] waiting turned into ChatAbortedError: ${stopped}`);
        if (!stopped) throw error;
      }
    );
  } finally {
    await fake.close();
  }
}

await survivesRateLimit('/chat/completions', true);
await survivesRateLimit('/responses', false);
await stopsWhenAborted();
console.log('\nAll rate-limit checks passed.');
