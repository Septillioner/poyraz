import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The MCP SDK is replaced by a scripted fake: every `Client` / transport that gets created is recorded,
// connecting to a server listed in `sdk.failing` rejects, and `sdk.gate` holds the next connects open.
const sdk = vi.hoisted(() => ({
  clients: [] as any[],
  transports: [] as any[],
  failing: new Set<string>(),
  listFails: new Set<string>(),
  gate: null as Promise<void> | null,
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    closed = false;
    id = '';
    constructor() {
      sdk.clients.push(this);
    }
    async connect(transport: any) {
      this.id = transport.id;
      if (sdk.gate) await sdk.gate;
      if (sdk.failing.has(transport.id)) throw new Error(`boom ${transport.id}`);
    }
    async listTools() {
      if (sdk.listFails.has(this.id)) throw new Error('list failed');
      return { tools: [{ name: 'search', description: 'looks up', inputSchema: { type: 'object', properties: {} } }] };
    }
    async close() {
      this.closed = true;
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    id: string;
    constructor(public params: any) {
      this.id = params.command;
      sdk.transports.push(this);
    }
  },
}));
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    id: string;
    constructor(url: URL, public opts: any) {
      this.id = url.href;
      sdk.transports.push(this);
    }
  },
}));
vi.mock('../../infrastructure/persistence/chat-debug-log.js', () => ({
  writeChatDebugLog: vi.fn(async () => {}),
}));

import { AgentBuilder } from '../../application/agent/agent-builder.js';
import { insecureFetch } from '../../infrastructure/mcp/insecure-fetch.js';
import { createMcpClientManager, mcpServerKey } from '../../infrastructure/mcp/mcp-client-manager.js';
import { mockLLM } from '../integration/mock-llm.js';

const A = 'http://a.test/mcp';
const B = 'http://b.test/mcp';
const C = 'http://c.test/mcp';
const D = 'http://d.test/mcp';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const clientFor = (id: string) => sdk.clients.filter((client) => client.id === id);

beforeEach(() => {
  sdk.clients.length = 0;
  sdk.transports.length = 0;
  sdk.failing.clear();
  sdk.listFails.clear();
  sdk.gate = null;
});
afterEach(() => {
  sdk.gate = null;
});

describe('mcpServerKey', () => {
  it('ignores key order and the false defaults, but not real differences', () => {
    const one = mcpServerKey({ url: A, headers: { x: '1', y: '2' } });
    const two = mcpServerKey({ headers: { y: '2', x: '1' }, url: A, disabled: false, ignoreCertificate: false });
    expect(one).toBe(two);
    expect(mcpServerKey({ url: A, headers: { x: '1' } })).not.toBe(one);
    expect(mcpServerKey({ url: A, ignoreCertificate: true })).not.toBe(mcpServerKey({ url: A }));
    expect(mcpServerKey({ command: 'n', args: ['a', 'b'] })).not.toBe(mcpServerKey({ command: 'n', args: ['b', 'a'] }));
  });
});

describe('McpClientManager.sync', () => {
  it('connects every server of the first call as added', async () => {
    const manager = createMcpClientManager();
    const result = await manager.sync({ a: { url: A }, b: { url: B } });

    expect(result.added).toEqual(['a', 'b']);
    expect(result.changed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.unchanged).toEqual([]);
    expect(result.states.map((s) => [s.id, s.status, s.toolCount])).toEqual([
      ['a', 'connected', 1],
      ['b', 'connected', 1],
    ]);
    expect(Object.keys(result.tools).sort()).toEqual(['mcp_a__search', 'mcp_b__search']);
  });

  it('touches only the added, changed and removed servers; the unchanged one keeps its connection and tools', async () => {
    const manager = createMcpClientManager();
    const first = await manager.sync({ a: { url: A }, b: { url: B }, c: { url: C } });
    const aTool = first.tools['mcp_a__search'];
    const [aClient, bClient, cClient] = [clientFor(A)[0], clientFor(B)[0], clientFor(C)[0]];
    sdk.clients.length = 0;

    const second = await manager.sync({ a: { url: A }, b: { url: B, headers: { k: 'v' } }, d: { url: D } });

    expect(second.added).toEqual(['d']);
    expect(second.changed).toEqual(['b']);
    expect(second.removed).toEqual(['c']);
    expect(second.unchanged).toEqual(['a']);
    // new clients only for the changed and the added server
    expect(sdk.clients.map((client) => client.id).sort()).toEqual([B, D]);
    expect(aClient.closed).toBe(false);
    expect(bClient.closed).toBe(true);
    expect(cClient.closed).toBe(true);
    expect(second.tools['mcp_a__search']).toBe(aTool);
    expect(second.tools['mcp_b__search']).not.toBe(first.tools['mcp_b__search']);
    expect(second.tools['mcp_c__search']).toBeUndefined();
    expect(second.states.map((s) => s.id)).toEqual(['a', 'b', 'd']);
  });

  it('treats a re-ordered but equal definition as unchanged', async () => {
    const manager = createMcpClientManager();
    await manager.sync({ s: { command: 'node', args: ['x'], env: { A: '1', B: '2' } } });
    sdk.clients.length = 0;
    const result = await manager.sync({ s: { env: { B: '2', A: '1' }, args: ['x'], command: 'node', disabled: false } });
    expect(result.unchanged).toEqual(['s']);
    expect(sdk.clients).toHaveLength(0);
  });

  it('a failing server does not throw: it is in the states, the others still connect', async () => {
    sdk.failing.add(B);
    const manager = createMcpClientManager();
    const result = await manager.sync({ a: { url: A }, b: { url: B } });

    expect(result.states.find((s) => s.id === 'a')?.status).toBe('connected');
    const failed = result.states.find((s) => s.id === 'b');
    expect(failed).toMatchObject({ status: 'error', toolCount: 0 });
    expect(failed?.error).toContain('boom');
    expect(Object.keys(result.tools)).toEqual(['mcp_a__search']);
  });

  it('does not retry an unchanged failed server by default; retryFailed does', async () => {
    sdk.failing.add(B);
    const manager = createMcpClientManager();
    await manager.sync({ b: { url: B } });
    expect(clientFor(B)).toHaveLength(1);

    const skipped = await manager.sync({ b: { url: B } });
    expect(skipped.unchanged).toEqual(['b']);
    expect(skipped.retried).toEqual([]);
    expect(clientFor(B)).toHaveLength(1);

    sdk.failing.clear();
    const retried = await manager.sync({ b: { url: B } }, { retryFailed: true });
    expect(retried.retried).toEqual(['b']);
    expect(retried.unchanged).toEqual([]);
    expect(retried.states[0].status).toBe('connected');
  });

  it('a changed definition fixes a failed server', async () => {
    sdk.failing.add(B);
    const manager = createMcpClientManager();
    await manager.sync({ b: { url: B } });
    const result = await manager.sync({ b: { url: C } });
    expect(result.changed).toEqual(['b']);
    expect(result.states[0]).toMatchObject({ id: 'b', status: 'connected' });
  });

  it('closes a half-open client when the tool listing fails', async () => {
    sdk.listFails.add(A);
    const manager = createMcpClientManager();
    const result = await manager.sync({ a: { url: A } });
    expect(result.states[0]).toMatchObject({ status: 'error', error: 'list failed' });
    expect(clientFor(A)[0].closed).toBe(true);
  });

  it('keeps disabled servers as disabled without connecting, and connects them once enabled', async () => {
    const manager = createMcpClientManager();
    const first = await manager.sync({ a: { url: A, disabled: true } });
    expect(first.states[0]).toMatchObject({ id: 'a', status: 'disabled' });
    expect(sdk.clients).toHaveLength(0);

    const second = await manager.sync({ a: { url: A } });
    expect(second.changed).toEqual(['a']);
    expect(second.states[0].status).toBe('connected');
  });

  it('ignoreCertificate is opt-in per server and a change of it reconnects', async () => {
    const manager = createMcpClientManager();
    await manager.sync({ strict: { url: A }, lax: { url: B, ignoreCertificate: true } });
    const byId = (id: string) => sdk.transports.find((t) => t.id === id);
    expect(byId(A).opts.fetch).toBeUndefined();
    expect(byId(B).opts.fetch).toBe(insecureFetch);

    sdk.clients.length = 0;
    sdk.transports.length = 0;
    const result = await manager.sync({ strict: { url: A, ignoreCertificate: true }, lax: { url: B, ignoreCertificate: true } });
    expect(result.changed).toEqual(['strict']);
    expect(result.unchanged).toEqual(['lax']);
    expect(byId(A).opts.fetch).toBe(insecureFetch);
  });

  it('an empty request disconnects everything', async () => {
    const manager = createMcpClientManager();
    await manager.sync({ a: { url: A }, b: { url: B } });
    const result = await manager.sync({});
    expect(result.removed).toEqual(['a', 'b']);
    expect(result.states).toEqual([]);
    expect(result.tools).toEqual({});
    expect(sdk.clients.every((client) => client.closed)).toBe(true);
  });

  it('concurrent calls run one after the other, in call order', async () => {
    let release!: () => void;
    sdk.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createMcpClientManager();
    const first = manager.sync({ a: { url: A } });
    const second = manager.sync({ a: { url: A }, b: { url: B } });
    const third = manager.sync({ b: { url: B } });
    await flush();

    // the first call is parked in connect(); the others have not started anything
    expect(sdk.clients).toHaveLength(1);

    release();
    const [r1, r2, r3] = await Promise.all([first, second, third]);
    expect(r1.added).toEqual(['a']);
    expect(r2.unchanged).toEqual(['a']);
    expect(r2.added).toEqual(['b']);
    expect(r3.removed).toEqual(['a']);
    expect(r3.unchanged).toEqual(['b']);
    expect(r3.states.map((s) => s.id)).toEqual(['b']);
  });

  it('connectAll and disconnect keep working next to sync', async () => {
    const manager = createMcpClientManager();
    await manager.connectAll({ a: { url: A }, b: { url: B } });
    expect(manager.listStates().map((s) => s.id)).toEqual(['a', 'b']);

    // connectAll records the keys, so a following sync sees both as unchanged
    const synced = await manager.sync({ a: { url: A }, b: { url: B } });
    expect(synced.unchanged).toEqual(['a', 'b']);

    await manager.disconnect('a');
    expect(manager.listStates().map((s) => s.id)).toEqual(['b']);
    await manager.disconnectAll();
    expect(manager.listStates()).toEqual([]);
    expect(Object.keys(manager.getTools())).toEqual([]);
  });
});

describe('Agent.syncMcp', () => {
  const build = (mcp: any) => new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Mcp(mcp).Build();
  const toolNames = (agent: ReturnType<typeof build>) => agent.compileRequest().toolSchemas.map((tool) => tool.name).sort();

  it('with mcp.enabled off it does nothing: empty result, nothing created, config untouched', async () => {
    for (const mcp of [undefined, { enabled: false, servers: { a: { url: A } } }, { servers: { a: { url: A } } }]) {
      const agent = mcp === undefined ? new AgentBuilder().Provider(mockLLM([{ content: 'x' }])).Build() : build(mcp);
      const before = JSON.stringify(agent.getConfig().mcp);
      const result = await agent.syncMcp({ b: { url: B } });
      expect(result).toEqual({ added: [], changed: [], removed: [], unchanged: [], retried: [], states: [], tools: {} });
      expect(agent.getMcpStates()).toEqual([]);
      expect(JSON.stringify(agent.getConfig().mcp)).toBe(before);
    }
    expect(sdk.clients).toHaveLength(0);
  });

  it('defaults to config.mcp.servers and updates it to the given list', async () => {
    const agent = build({ enabled: true, servers: { a: { url: A } } });
    const first = await agent.syncMcp();
    expect(first.added).toEqual(['a']);
    expect(toolNames(agent)).toEqual(['mcp_a__search']);

    const second = await agent.syncMcp({ a: { url: A }, b: { url: B } });
    expect(second).toMatchObject({ added: ['b'], unchanged: ['a'] });
    expect(Object.keys(agent.getConfig().mcp?.servers ?? {})).toEqual(['a', 'b']);
    expect(agent.getMcpStates().map((s) => s.id)).toEqual(['a', 'b']);
    expect(toolNames(agent)).toEqual(['mcp_a__search', 'mcp_b__search']);
  });

  it('removes the tools of dropped servers and leaves the others in place', async () => {
    const agent = build({ enabled: true, servers: { a: { url: A }, b: { url: B } } });
    await agent.init();
    expect(toolNames(agent)).toEqual(['mcp_a__search', 'mcp_b__search']);
    sdk.clients.length = 0;

    const result = await agent.syncMcp({ a: { url: A }, c: { url: C } });
    expect(result).toMatchObject({ added: ['c'], removed: ['b'], unchanged: ['a'] });
    expect(sdk.clients.map((client) => client.id)).toEqual([C]);
    expect(toolNames(agent)).toEqual(['mcp_a__search', 'mcp_c__search']);
  });

  it('a failing server is returned in the states, not thrown, and brings no tool', async () => {
    sdk.failing.add(B);
    const agent = build({ enabled: true, servers: { a: { url: A } } });
    const result = await agent.syncMcp({ a: { url: A }, b: { url: B } });
    expect(result.states.find((s) => s.id === 'b')?.status).toBe('error');
    expect(agent.getMcpStates().find((s) => s.id === 'b')?.error).toContain('boom');
    expect(toolNames(agent)).toEqual(['mcp_a__search']);
  });

  it('runs together with connectMcp / disconnectMcp one after the other', async () => {
    const agent = build({ enabled: true, servers: { a: { url: A } } });
    await Promise.all([agent.connectMcp(), agent.syncMcp({ b: { url: B } }), agent.syncMcp({ c: { url: C } })]);
    expect(agent.getMcpStates().map((s) => s.id)).toEqual(['c']);
    expect(toolNames(agent)).toEqual(['mcp_c__search']);

    await Promise.all([agent.syncMcp({ a: { url: A } }), agent.disconnectMcp()]);
    expect(agent.getMcpStates()).toEqual([]);
    expect(toolNames(agent)).toEqual([]);
  });
});
