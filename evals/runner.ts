import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { AgentBuilder } from '../application/agent/agent-builder.js';
import type { AgentStreamEvent } from '../domain/events.js';
import { inferProfileForModel } from '../application/services/resolve-model-profile.js';
import {
  resolveApiKeyForProfile,
  type ModelProfile,
} from '../domain/model-profile.js';
import { createLLMProvider } from '../infrastructure/llm/create-provider.js';
import { loadAllEnv } from '../infrastructure/persistence/poyraz-home.js';
import { gradeEfficiency } from './graders/efficiency-grader.js';
import { runOutcomeCheck } from './graders/outcome-grader.js';
import { buildTraceMetrics, gradeTrace } from './graders/trace-grader.js';
import { ALL_SCENARIOS } from './scenarios/index.js';
import { createFixture } from './fixtures/create-fixture.js';
import {
  computeComposite,
  DIFFICULTY_ORDER,
  isPassed,
  type EvalDifficulty,
  type EvalHistoryRecord,
  type EvalResult,
  type EvalScenario,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const RESULTS_DIR = path.join(__dirname, 'results');
const HISTORY_DIR = path.join(__dirname, 'history');

const PROVIDER_ENV_KEYS: Record<ModelProfile['provider'], string> = {
  openai: 'OPENAI_API_KEY',
  groq: 'GROQ_API_KEY',
  gemini: 'GEMINI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ollama: 'OLLAMA_HOST',
};

const MODEL_LIKE = /^[a-z0-9][a-z0-9._-]*$/i;

function loadEvalEnv(): void {
  loadAllEnv(REPO_ROOT);
}

function resolveEvalProfile(model: string): ModelProfile {
  const profile = inferProfileForModel(model);
  if (profile.provider === 'ollama') {
    return profile;
  }

  const apiKey = resolveApiKeyForProfile(profile);
  if (!apiKey.trim()) {
    const envKey = PROVIDER_ENV_KEYS[profile.provider];
    throw new Error(
      `Missing API key for ${profile.provider} (model: ${model}). ` +
        `Set ${envKey} in ${path.join(REPO_ROOT, '.env')} or ~/.poyraz/.env, then rerun.`
    );
  }

  return profile;
}

const DIFFICULTY_SET = new Set<string>(DIFFICULTY_ORDER);
const SCENARIO_ID_SET = new Set<string>(ALL_SCENARIOS.map((s) => s.id));
const SCENARIO_ID_PREFIX = /^(easy|medium|hard|challenging)-/i;

function looksLikeScenarioId(value: string): boolean {
  return SCENARIO_ID_PREFIX.test(value);
}

function looksLikeModelId(value: string): boolean {
  if (DIFFICULTY_SET.has(value.toLowerCase())) return false;
  if (looksLikeScenarioId(value)) return false;
  return MODEL_LIKE.test(value) && !value.startsWith('-');
}

function parseDifficulties(raw?: string): EvalDifficulty[] | undefined {
  if (!raw) return undefined;
  const parts = raw.split(',').map((p) => p.trim().toLowerCase());
  const valid = parts.filter((p): p is EvalDifficulty => DIFFICULTY_SET.has(p));
  return valid.length > 0 ? valid : undefined;
}

function parseArgs(argv: string[]): {
  models: string[];
  scenarioIds?: string[];
  difficulties?: EvalDifficulty[];
} {
  const models: string[] = [];
  let scenarioIds: string[] | undefined;
  let difficulties: EvalDifficulty[] | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--model' && argv[i + 1]) {
      models.push(argv[++i]);
    } else if (arg === '--all') {
      models.push('gpt-4o-mini', 'gpt-4o');
    } else if (arg === '--scenario' && argv[i + 1]) {
      scenarioIds = scenarioIds ?? [];
      scenarioIds.push(argv[++i]);
    } else if (arg === '--difficulty' && argv[i + 1]) {
      const parsed = parseDifficulties(argv[++i]);
      if (parsed) {
        difficulties = [...new Set([...(difficulties ?? []), ...parsed])];
      }
    } else if (DIFFICULTY_SET.has(arg.toLowerCase())) {
      const tier = arg.toLowerCase() as EvalDifficulty;
      difficulties = [...new Set([...(difficulties ?? []), tier])];
    } else if (looksLikeScenarioId(arg)) {
      scenarioIds = scenarioIds ?? [];
      scenarioIds.push(arg);
    } else if (looksLikeModelId(arg)) {
      models.push(arg);
    }
  }

  if (models.length === 0) {
    models.push(process.env.EVAL_MODEL || 'gpt-4o-mini');
  }

  return { models, scenarioIds, difficulties };
}

function filterScenarios(
  scenarioIds?: string[],
  difficulties?: EvalDifficulty[]
): EvalScenario[] {
  if (scenarioIds?.length) {
    return ALL_SCENARIOS.filter((s) => scenarioIds.includes(s.id));
  }
  if (difficulties?.length) {
    const set = new Set(difficulties);
    return ALL_SCENARIOS.filter((s) => set.has(s.difficulty));
  }
  return ALL_SCENARIOS;
}

interface ScenarioRun {
  result: EvalResult;
  history: EvalHistoryRecord;
}

async function runScenario(scenario: EvalScenario, model: string): Promise<ScenarioRun> {
  const fixture = await createFixture(`poyraz-eval-${scenario.id}-`);
  const prevCwd = process.cwd();
  const events: AgentStreamEvent[] = [];

  try {
    process.chdir(fixture.workspace);
    await scenario.setup(fixture.workspace);

    const profile = resolveEvalProfile(model);
    const apiKey = resolveApiKeyForProfile(profile);
    const provider = createLLMProvider(profile, apiKey);

    const agent = new AgentBuilder()
      .Name('EvalAgent')
      .Provider(provider)
      .WithModelProfile(profile)
      .ApiKey(apiKey)
      .DefaultSystemTools({ read: true, write: true, execute: false, tasks: true, grep: true })
      .RoutingPolicy({ maxToolRounds: 15, repeatCallLimit: 3, deterministicMode: true })
      .Build();

    if (scenario.mode) {
      agent.setMode(scenario.mode);
    }

    const result = await agent.chat(scenario.prompt, {
      onEvent: (event) => events.push(event),
    });

    const messages = agent.getMessageHistory();
    const trace = buildTraceMetrics({
      messages,
      events,
      totalTokens: result.usage.totalTokens ?? 0,
    });

    const outcome = await runOutcomeCheck(fixture.workspace, trace, scenario.checkOutcome);
    const traceScore = gradeTrace(trace);
    const efficiencyScore = gradeEfficiency(trace.metrics.totalTokens, scenario.budget);
    const composite = computeComposite(traceScore, outcome.score, efficiencyScore);
    const timestamp = new Date().toISOString();

    return {
      result: {
        scenarioId: scenario.id,
        model,
        difficulty: scenario.difficulty,
        category: scenario.category,
        timestamp,
        traceScore,
        outcomeScore: outcome.score,
        efficiencyScore,
        composite,
        passed: isPassed(composite),
        metrics: trace.metrics,
        details: outcome.check.details,
      },
      history: {
        scenarioId: scenario.id,
        model,
        difficulty: scenario.difficulty,
        category: scenario.category,
        timestamp,
        prompt: scenario.prompt,
        messages,
        events: events.filter((event) => event.type !== 'text.delta'),
        metrics: trace.metrics,
      },
    };
  } finally {
    process.chdir(prevCwd);
    await fixture.cleanup();
  }
}

function formatRunStamp(startedAt: Date): string {
  return startedAt.toISOString().slice(0, 19).replace(/:/g, '-');
}

function sanitizeModelDir(model: string): string {
  return model.replace(/[/:]/g, '_');
}

function formatTokenCount(tokens: number): string {
  return tokens.toLocaleString('en-US');
}

function prepareRunFilePath(model: string, startedAt: Date): string {
  const modelDir = path.join(RESULTS_DIR, sanitizeModelDir(model));
  return path.join(modelDir, `${formatRunStamp(startedAt)}.json`);
}

function prepareRunHistoryDir(model: string, startedAt: Date): string {
  return path.join(HISTORY_DIR, sanitizeModelDir(model), formatRunStamp(startedAt));
}

async function saveScenarioHistory(
  historyDir: string,
  history: EvalHistoryRecord
): Promise<string> {
  await fs.mkdir(historyDir, { recursive: true });
  const filePath = path.join(historyDir, `${history.scenarioId}.json`);
  await fs.writeFile(filePath, JSON.stringify(history, null, 2), 'utf-8');
  return filePath;
}

async function appendResultToRun(filePath: string, result: EvalResult): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  let existing: EvalResult[] = [];
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    existing = JSON.parse(raw) as EvalResult[];
  } catch {
    existing = [];
  }

  existing.push(result);
  await fs.writeFile(filePath, JSON.stringify(existing, null, 2), 'utf-8');
}

function printRunSummary(model: string, results: EvalResult[]): void {
  console.log(`\n--- Summary: ${model} ---`);
  const tiers = [...DIFFICULTY_ORDER];
  let totalPassed = 0;
  let totalCount = 0;
  let compositeSum = 0;
  let totalTokens = 0;

  for (const tier of tiers) {
    const tierResults = results.filter((r) => r.difficulty === tier);
    if (tierResults.length === 0) continue;
    const passed = tierResults.filter((r) => r.passed).length;
    const avg = Math.round(
      tierResults.reduce((s, r) => s + r.composite, 0) / tierResults.length
    );
    const tierTokens = tierResults.reduce((s, r) => s + r.metrics.totalTokens, 0);
    totalPassed += passed;
    totalCount += tierResults.length;
    compositeSum += tierResults.reduce((s, r) => s + r.composite, 0);
    totalTokens += tierTokens;
    console.log(
      `  ${tier.padEnd(6)} ${passed}/${tierResults.length} passed  avg=${avg}  tokens=${formatTokenCount(tierTokens)}`
    );
  }

  const totalAvg = totalCount > 0 ? Math.round(compositeSum / totalCount) : 0;
  console.log(`  total  ${totalPassed}/${totalCount} passed  avg=${totalAvg}  tokens=${formatTokenCount(totalTokens)}`);
}

async function main(): Promise<void> {
  loadEvalEnv();

  const { models, scenarioIds, difficulties } = parseArgs(process.argv.slice(2));

  if (scenarioIds?.length) {
    const unknown = scenarioIds.filter((id) => !SCENARIO_ID_SET.has(id));
    if (unknown.length > 0) {
      console.error(`Unknown scenario id(s): ${unknown.join(', ')}`);
      console.error(`Valid scenario ids:\n  ${[...SCENARIO_ID_SET].join('\n  ')}`);
      process.exit(1);
    }
  }

  const scenarios = filterScenarios(scenarioIds, difficulties);

  if (scenarios.length === 0) {
    console.error('No scenarios matched.');
    process.exit(1);
  }

  console.log(`Running ${scenarios.length} scenario(s)...`);

  for (const model of models) {
    console.log(`\n=== Model: ${model} ===`);
    try {
      resolveEvalProfile(model);
    } catch (error) {
      console.error(`  SKIP: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    const modelResults: EvalResult[] = [];
    const runStartedAt = new Date();
    const resultFilePath = prepareRunFilePath(model, runStartedAt);
    const historyDir = prepareRunHistoryDir(model, runStartedAt);

    for (const scenario of scenarios) {
      console.log(`Running [${scenario.difficulty}] ${scenario.id}...`);
      try {
        const { result, history } = await runScenario(scenario, model);
        await appendResultToRun(resultFilePath, result);
        const historyFilePath = await saveScenarioHistory(historyDir, history);
        modelResults.push(result);
        console.log(
          `  trace=${result.traceScore} outcome=${result.outcomeScore} efficiency=${result.efficiencyScore} composite=${result.composite} passed=${result.passed} tokens=${formatTokenCount(result.metrics.totalTokens)}`
        );
        console.log(`  saved: ${resultFilePath}`);
        console.log(`  history: ${historyFilePath}`);
      } catch (error) {
        console.error(`  FAILED: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    printRunSummary(model, modelResults);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
