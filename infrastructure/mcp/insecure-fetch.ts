import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';

import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

/** Statuses a Response refuses to pair with a body. */
const BODYLESS_STATUSES = new Set([204, 304]);
const HTTPS_FALLBACK_PORT = 443;
const HTTP_FALLBACK_PORT = 80;

/**
 * fetch for MCP HTTP transports that skips TLS verification for that one server only.
 * Node's global fetch has no per-request switch for it, and NODE_TLS_REJECT_UNAUTHORIZED
 * would silence certificate checks for every connection the host makes, so the request
 * is built on node:http(s) with `rejectUnauthorized: false` instead.
 */
export const insecureFetch: FetchLike = async (url, init) => {
  const target = new URL(url);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new TypeError(`MCP HTTP transport needs an http(s) URL, got ${target.protocol}`);
  }
  const signal = init?.signal ?? undefined;
  if (signal?.aborted) throw signal.reason ?? new Error('Request aborted');

  const payload = await toRequestBody(init?.body);
  const secure = target.protocol === 'https:';
  const options: RequestOptions = {
    hostname: target.hostname,
    port: target.port || (secure ? HTTPS_FALLBACK_PORT : HTTP_FALLBACK_PORT),
    path: `${target.pathname}${target.search}`,
    method: (init?.method ?? 'GET').toUpperCase(),
    headers: requestHeaders(init, payload),
    rejectUnauthorized: false,
  };
  const send = secure ? httpsRequest : httpRequest;

  return await new Promise<Response>((resolve, reject) => {
    const request = send(options, (response) => {
      const status = response.statusCode ?? 599;
      resolve(
        new Response(responseBody(response, status), {
          status,
          statusText: response.statusMessage,
          headers: responseHeaders(response.headers),
        }),
      );
    });
    const onAbort = () => {
      request.destroy();
      reject(signal?.reason ?? new Error('Request aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    request.once('close', () => signal?.removeEventListener('abort', onAbort));
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
};

async function toRequestBody(body: RequestInit['body']): Promise<Buffer | null> {
  if (body === null || body === undefined) return null;
  if (typeof body === 'string') return Buffer.from(body);
  if (body instanceof URLSearchParams) return Buffer.from(body.toString());
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (body instanceof Blob) return Buffer.from(await body.arrayBuffer());
  throw new TypeError('Unsupported MCP request body');
}

function requestHeaders(init: RequestInit | undefined, payload: Buffer | null): Record<string, string> {
  const headers: Record<string, string> = {};
  new Headers(init?.headers ?? undefined).forEach((value, name) => {
    headers[name] = value;
  });
  if (payload && !('content-length' in headers)) headers['content-length'] = String(payload.length);
  return headers;
}

function responseHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.append(name, value);
    }
  }
  return headers;
}

function responseBody(response: IncomingMessage, status: number): ReadableStream<Uint8Array> | null {
  if (BODYLESS_STATUSES.has(status)) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      response.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      response.on('end', () => controller.close());
      response.on('error', (error) => controller.error(error));
    },
    cancel() {
      response.destroy();
    },
  });
}