import { describe, expect, it, vi } from 'vitest';
import {
  MIN_CONTEXT_WINDOW_TOKENS,
  normalizeContextWindow,
  resolveContextWindow,
} from '../../application/context/context-window.js';

describe('normalizeContextWindow', () => {
  it('keeps whole numbers from 1000 up, rounds down, and rejects the rest', () => {
    expect(MIN_CONTEXT_WINDOW_TOKENS).toBe(1000);
    expect(normalizeContextWindow(128_000)).toBe(128_000);
    expect(normalizeContextWindow(1000.9)).toBe(1000);
    for (const bad of [999, 0, -5, NaN, Infinity, '8000', null, undefined, {}]) {
      expect(normalizeContextWindow(bad)).toBeUndefined();
    }
  });
});

describe('resolveContextWindow', () => {
  const model = 'gpt-test';

  it('asks catalog, then provider cache, then static table, and reports who answered', async () => {
    const catalog = vi.fn(() => 200_000);
    const providerCache = { [model]: 64_000 };
    const staticTable = new Map([[model, 32_000]]);

    expect(await resolveContextWindow({ model, catalog, providerCache, staticTable })).toEqual({
      tokens: 200_000,
      source: 'catalog',
    });
    expect(await resolveContextWindow({ model, catalog: () => undefined, providerCache, staticTable })).toEqual({
      tokens: 64_000,
      source: 'provider-cache',
    });
    expect(await resolveContextWindow({ model, providerCache: {}, staticTable })).toEqual({
      tokens: 32_000,
      source: 'static-table',
    });
  });

  it('does not ask later sources after a hit', async () => {
    const providerCache = vi.fn(() => 1);
    const staticTable = vi.fn(() => 1);
    await resolveContextWindow({ model, catalog: () => 50_000, providerCache, staticTable });
    expect(providerCache).not.toHaveBeenCalled();
    expect(staticTable).not.toHaveBeenCalled();
  });

  it('hands model, host and provider to function sources', async () => {
    const catalog = vi.fn(async () => 16_000);
    await resolveContextWindow({ model, host: 'http://h', provider: 'ollama', catalog });
    expect(catalog).toHaveBeenCalledWith({ model, host: 'http://h', provider: 'ollama' });
  });

  it('accepts async functions, Records and Maps in any slot', async () => {
    expect(await resolveContextWindow({ model, catalog: async () => 8_000 })).toEqual({ tokens: 8_000, source: 'catalog' });
    expect(await resolveContextWindow({ model, catalog: new Map([[model, 9_000]]) })).toEqual({ tokens: 9_000, source: 'catalog' });
    expect(await resolveContextWindow({ model, staticTable: async () => 7_000 })).toEqual({ tokens: 7_000, source: 'static-table' });
  });

  it('skips invalid answers instead of stopping at them', async () => {
    const result = await resolveContextWindow({
      model,
      catalog: () => 0,
      providerCache: { [model]: 500 },
      staticTable: () => 4_096.7,
    });
    expect(result).toEqual({ tokens: 4_096, source: 'static-table' });
  });

  it('is undefined when nothing knows the model or no source is given', async () => {
    expect(await resolveContextWindow({ model })).toBeUndefined();
    expect(await resolveContextWindow({ model, catalog: () => undefined, providerCache: {}, staticTable: new Map() })).toBeUndefined();
  });

  it('tables are keyed by own properties only (no prototype keys)', async () => {
    expect(await resolveContextWindow({ model: 'constructor', staticTable: {} })).toBeUndefined();
    expect(await resolveContextWindow({ model: 'toString', providerCache: {} })).toBeUndefined();
  });

  it('a throwing or rejecting source propagates', async () => {
    await expect(
      resolveContextWindow({ model, catalog: () => { throw new Error('catalog down'); }, staticTable: { [model]: 8_000 } })
    ).rejects.toThrow('catalog down');
    await expect(
      resolveContextWindow({ model, catalog: async () => { throw new Error('later'); } })
    ).rejects.toThrow('later');
  });
});
