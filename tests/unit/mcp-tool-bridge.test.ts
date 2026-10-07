import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { describe, expect, it } from 'vitest';
import { bridgeMcpTool } from '../../infrastructure/mcp/mcp-tool-bridge.js';

describe('bridgeMcpTool cancellation', () => {
  it('passes the tool abort signal to the MCP request', async () => {
    let receivedSignal: AbortSignal | undefined;
    const client = {
      callTool: (_params: unknown, _schema?: unknown, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.signal;
          if (!signal) return;
          if (signal.aborted) {
            reject(new Error('Request aborted'));
            return;
          }
          signal.addEventListener('abort', () => reject(new Error('Request aborted')), { once: true });
        });
      },
    } as unknown as Client;
    const controller = new AbortController();
    const tool = bridgeMcpTool('test-server', client, {
      name: 'slow_tool',
      inputSchema: { type: 'object', properties: {} },
    });

    const pending = tool.execute({}, { abortSignal: controller.signal });
    controller.abort();
    const result = await pending;

    expect(receivedSignal).toBe(controller.signal);
    expect(result).toMatchObject({ isError: true });
  });
});
