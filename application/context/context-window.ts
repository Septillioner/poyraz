/** Smallest context window the library accepts (`ContextWindow(...)`, `Agent.setContextWindow(...)`). */
export const MIN_CONTEXT_WINDOW_TOKENS = 1000;

/** A finite number of at least `MIN_CONTEXT_WINDOW_TOKENS` (rounded down); anything else is `undefined`. */
export function normalizeContextWindow(tokens: unknown): number | undefined {
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < MIN_CONTEXT_WINDOW_TOKENS) return undefined;
  return Math.floor(tokens);
}

/** Which source answered, in resolution order. */
export type ContextWindowSource = 'catalog' | 'provider-cache' | 'static-table';

/** What a lookup is asked about. `host` and `provider` are passed through untouched for the host's own lookups. */
export interface ContextWindowQuery {
  model: string;
  host?: string;
  provider?: string;
}

/**
 * One source of context windows: a function (sync or async) given the query, or a plain table keyed by model id.
 * A source answers with a token count, or `undefined` when it does not know the model.
 */
export type ContextWindowLookup =
  | ((query: ContextWindowQuery) => number | undefined | Promise<number | undefined>)
  | Readonly<Record<string, number>>
  | ReadonlyMap<string, number>;

export interface ResolveContextWindowOptions extends ContextWindowQuery {
  /** Asked first: an explicit catalog or user override. */
  catalog?: ContextWindowLookup;
  /** Asked second: a cache filled by the provider (for example lengths read from a local server). */
  providerCache?: ContextWindowLookup;
  /** Asked last: a static table shipped with the host. */
  staticTable?: ContextWindowLookup;
}

export interface ContextWindowResolution {
  /** The window, validated like `ContextWindow(...)`: a whole number of at least 1000. */
  tokens: number;
  /** The source that answered. */
  source: ContextWindowSource;
}

async function lookup(source: ContextWindowLookup | undefined, query: ContextWindowQuery): Promise<number | undefined> {
  if (!source) return undefined;
  if (typeof source === 'function') return normalizeContextWindow(await source(query));
  if (source instanceof Map) return normalizeContextWindow(source.get(query.model));
  const table = source as Readonly<Record<string, number>>;
  return Object.prototype.hasOwnProperty.call(table, query.model) ? normalizeContextWindow(table[query.model]) : undefined;
}

/**
 * Finds the context window of a model: `catalog` first (an explicit override wins), then `providerCache`,
 * then `staticTable`. The first source with a valid value (see `normalizeContextWindow`) wins and later
 * sources are not asked; an absent source, `undefined` or an invalid number falls through to the next.
 * Returns `undefined` when nothing resolves. A lookup that throws or rejects propagates; wrap it for
 * best-effort behaviour.
 *
 * The library knows no catalog or table of its own: where the numbers come from is the host's business.
 * Hand the result to `agent.setContextWindow(resolution?.tokens)` or `AgentBuilder.ContextWindow(...)`.
 */
export async function resolveContextWindow(options: ResolveContextWindowOptions): Promise<ContextWindowResolution | undefined> {
  const { catalog, providerCache, staticTable, ...query } = options;
  const sources: Array<[ContextWindowSource, ContextWindowLookup | undefined]> = [
    ['catalog', catalog],
    ['provider-cache', providerCache],
    ['static-table', staticTable],
  ];
  for (const [source, candidate] of sources) {
    const tokens = await lookup(candidate, query);
    if (tokens !== undefined) return { tokens, source };
  }
  return undefined;
}
