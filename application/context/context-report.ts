import type { ChatMessage, TokenUsage } from '../../domain/llm.js';
import {
  CONTEXT_CATEGORIES,
  emptyCategoryTokens,
  type CompiledToolSchema,
  type ContextCategory,
  type ContextCategoryTokens,
  type ContextDrift,
  type ContextEstimate,
  type ContextMeter,
  type ContextRealSnapshot,
  type ContextRequestRecord,
  type MessageContextMeta,
  type SystemPromptParts,
} from '../../domain/context.js';
import type { TokenEstimator } from './token-estimate.js';

export interface MessageEntry {
  message: ChatMessage;
  meta: MessageContextMeta;
}

export interface EstimateRequestInput {
  entries: ReadonlyArray<MessageEntry>;
  toolSchemas: ReadonlyArray<CompiledToolSchema>;
  /**
   * The built system prompt. When the stored system message equals `content`, its
   * characters are split into `system` and `rules`; otherwise it counts as `system`.
   */
  systemPrompt?: { content: string; parts: SystemPromptParts };
  estimator: TokenEstimator;
}

/**
 * Local estimate for one request from stored message metadata and tool schemas.
 * Characters are summed per category first and converted once, so changing the
 * estimator ratio (calibration) applies to everything already stored.
 */
export function estimateRequest(input: EstimateRequestInput): ContextEstimate {
  const chars = emptyCategoryTokens();
  const overhead = emptyCategoryTokens();

  for (const { message, meta } of input.entries) {
    const metaChars = { ...meta.chars };
    if (
      message.role === 'system' &&
      input.systemPrompt &&
      message.content === input.systemPrompt.content &&
      input.systemPrompt.parts.rules.length > 0
    ) {
      const total = message.content.length;
      const rules = Math.min(total, input.systemPrompt.parts.rules.length);
      metaChars.rules = rules;
      metaChars.system = total - rules;
    }
    for (const key of Object.keys(metaChars) as ContextCategory[]) {
      chars[key] += metaChars[key] ?? 0;
    }
    overhead[meta.category] += meta.overheadTokens;
  }

  for (const schema of input.toolSchemas) {
    chars[schema.category] += schema.chars;
  }

  const categories = emptyCategoryTokens();
  let total = 0;
  let totalChars = 0;
  let overheadTokens = 0;
  for (const key of CONTEXT_CATEGORIES) {
    categories[key] = input.estimator.tokensForChars(chars[key]) + overhead[key];
    total += categories[key];
    totalChars += chars[key];
    overheadTokens += overhead[key];
  }
  return { categories, total, chars: totalChars, overheadTokens };
}

function wholeTokens(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  return Math.round(value);
}

/**
 * Rescales category shares so they add up to exactly `target` (largest-remainder
 * rounding). With no shares at all the whole target lands in `conversation`.
 * This is how a provider's single prompt total becomes a per-category breakdown.
 */
export function scaleCategoriesToTotal(
  categories: ContextCategoryTokens,
  target: number
): ContextCategoryTokens {
  const goal = wholeTokens(target);
  const scaled = emptyCategoryTokens();
  if (goal === 0) return scaled;

  const sum = CONTEXT_CATEGORIES.reduce((acc, key) => acc + Math.max(0, categories[key]), 0);
  if (sum === 0) {
    scaled.conversation = goal;
    return scaled;
  }

  const remainders: { key: ContextCategory; fraction: number }[] = [];
  let used = 0;
  for (const key of CONTEXT_CATEGORIES) {
    const exact = (Math.max(0, categories[key]) * goal) / sum;
    const floor = Math.floor(exact);
    scaled[key] = floor;
    used += floor;
    remainders.push({ key, fraction: exact - floor });
  }
  remainders.sort((a, b) => b.fraction - a.fraction);
  for (let i = 0; i < goal - used; i++) {
    scaled[remainders[i % remainders.length].key] += 1;
  }
  return scaled;
}

/** Estimate minus real. Positive means the estimate ran high. */
export function computeDrift(estimateTotal: number, realTotal: number): ContextDrift {
  const tokens = estimateTotal - realTotal;
  if (!Number.isFinite(realTotal) || realTotal <= 0) return { tokens, ratio: null, percent: null };
  return {
    tokens,
    ratio: estimateTotal / realTotal,
    percent: Math.round(((estimateTotal - realTotal) / realTotal) * 1000) / 10,
  };
}

/** Pairs the pre-send estimate with the provider-reported usage of the same request. */
export function completeRecord(record: ContextRequestRecord, usage: TokenUsage): ContextRequestRecord {
  return {
    ...record,
    real: { ...usage },
    drift: computeDrift(record.estimate.total, usage.promptTokens),
  };
}

/** Real breakdown of a finished request: estimate shares scaled to the provider's promptTokens. */
export function realSnapshot(record: ContextRequestRecord): ContextRealSnapshot | undefined {
  if (!record.real || !record.drift) return undefined;
  const total = wholeTokens(record.real.promptTokens);
  return {
    seq: record.seq,
    at: record.at,
    usage: { ...record.real },
    categories: scaleCategoriesToTotal(record.estimate.categories, total),
    total,
    estimate: record.estimate,
    drift: record.drift,
  };
}

export function buildMeter(
  source: ContextMeter['source'],
  categories: ContextCategoryTokens,
  total: number,
  windowTokens: number | undefined
): ContextMeter {
  const window =
    typeof windowTokens === 'number' && Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null;
  return {
    source,
    categories: { ...categories },
    total,
    windowTokens: window,
    percent: window === null ? null : Math.round((total / window) * 1000) / 10,
  };
}
