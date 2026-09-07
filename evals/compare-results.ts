import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DIFFICULTY_ORDER,
  type EvalDifficulty,
  type EvalResult,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');

interface ScenarioTrend {
  scenarioId: string;
  model: string;
  oldest: number;
  newest: number;
  delta: number;
}

interface LeaderboardRow {
  model: string;
  byDifficulty: Record<EvalDifficulty, { avg: number; passed: number; total: number }>;
  passRate: number;
  avgTokens: number;
  totalTokens: number;
}

function compositeOf(result: EvalResult): number {
  return result.composite ?? Math.round((result.traceScore + result.outcomeScore + result.efficiencyScore) / 3);
}

function difficultyOf(result: EvalResult): EvalDifficulty {
  return result.difficulty ?? 'medium';
}

async function loadAllResults(): Promise<EvalResult[]> {
  const modelDirs = await fs.readdir(RESULTS_DIR).catch(() => [] as string[]);
  const allResults: EvalResult[] = [];

  for (const dir of modelDirs) {
    const full = path.join(RESULTS_DIR, dir);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const entries = await fs.readdir(full).catch(() => [] as string[]);
    for (const file of entries.filter((f) => f.endsWith('.json'))) {
      const raw = await fs.readFile(path.join(full, file), 'utf-8');
      allResults.push(...(JSON.parse(raw) as EvalResult[]));
    }
  }

  return allResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function latestRunPerScenarioModel(results: EvalResult[]): EvalResult[] {
  const map = new Map<string, EvalResult>();
  for (const result of results) {
    const key = `${result.model}::${result.scenarioId}`;
    const existing = map.get(key);
    if (!existing || result.timestamp > existing.timestamp) {
      map.set(key, result);
    }
  }
  return [...map.values()];
}

function buildTrends(results: EvalResult[], lastN: number): ScenarioTrend[] {
  const byKey = new Map<string, EvalResult[]>();
  for (const result of results) {
    const key = `${result.scenarioId}::${result.model}`;
    const list = byKey.get(key) ?? [];
    list.push(result);
    byKey.set(key, list);
  }

  const trends: ScenarioTrend[] = [];
  for (const [key, list] of byKey) {
    const slice = list.slice(-lastN);
    if (slice.length === 0) continue;
    const [scenarioId, model] = key.split('::');
    const oldest = compositeOf(slice[0]);
    const newest = compositeOf(slice[slice.length - 1]);
    trends.push({ scenarioId, model, oldest, newest, delta: newest - oldest });
  }

  return trends.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

function buildLeaderboard(latest: EvalResult[]): LeaderboardRow[] {
  const byModel = new Map<string, EvalResult[]>();
  for (const result of latest) {
    const list = byModel.get(result.model) ?? [];
    list.push(result);
    byModel.set(result.model, list);
  }

  const rows: LeaderboardRow[] = [];
  for (const [model, results] of byModel) {
    const byDifficulty = {} as LeaderboardRow['byDifficulty'];
    for (const tier of DIFFICULTY_ORDER) {
      const tierResults = results.filter((r) => difficultyOf(r) === tier);
      const total = tierResults.length;
      const passed = tierResults.filter((r) => r.passed ?? compositeOf(r) >= 80).length;
      const avg =
        total > 0
          ? Math.round(tierResults.reduce((s, r) => s + compositeOf(r), 0) / total)
          : 0;
      byDifficulty[tier] = { avg, passed, total };
    }
    const passRate =
      results.length > 0
        ? Math.round(
            (results.filter((r) => r.passed ?? compositeOf(r) >= 80).length / results.length) *
              100
          )
        : 0;
    const totalTokens = results.reduce((s, r) => s + (r.metrics?.totalTokens ?? 0), 0);
    const avgTokens = results.length > 0 ? Math.round(totalTokens / results.length) : 0;
    rows.push({ model, byDifficulty, passRate, avgTokens, totalTokens });
  }

  return rows.sort((a, b) => b.passRate - a.passRate);
}

async function main(): Promise<void> {
  const lastN = Number(process.argv.find((a) => a.startsWith('--last='))?.split('=')[1] ?? 5);
  const allResults = await loadAllResults();

  if (allResults.length === 0) {
    console.log('No eval results found in evals/results/');
    return;
  }

  const trends = buildTrends(allResults, lastN);
  console.log(`\nEval trends (last ${lastN} runs per scenario/model):\n`);
  for (const row of trends) {
    const sign = row.delta >= 0 ? '+' : '';
    console.log(
      `${row.scenarioId.padEnd(32)} ${row.model.padEnd(14)} ${String(row.oldest).padStart(3)} → ${String(row.newest).padStart(3)}  (${sign}${row.delta})`
    );
  }

  const latest = latestRunPerScenarioModel(allResults);
  const leaderboard = buildLeaderboard(latest);

  console.log('\nLeaderboard (latest run per scenario):\n');
  const headerCols = DIFFICULTY_ORDER.map((tier) => tier.padStart(12)).join(' ');
  console.log(`${'Model'.padEnd(16)} ${headerCols} ${'pass%'.padStart(6)}`);
  for (const row of leaderboard) {
    const fmt = (tier: EvalDifficulty) => {
      const cell = row.byDifficulty[tier];
      if (!cell || cell.total === 0) return '-'.padStart(12);
      return `${cell.avg}`.padStart(12);
    };
    const cols = DIFFICULTY_ORDER.map((tier) => fmt(tier)).join(' ');
    console.log(`${row.model.padEnd(16)} ${cols} ${String(row.passRate).padStart(5)}%`);
  }

  console.log('\nPass rate by difficulty (latest):\n');
  for (const row of leaderboard) {
    for (const tier of DIFFICULTY_ORDER) {
      const cell = row.byDifficulty[tier];
      if (cell.total === 0) continue;
      const rate = Math.round((cell.passed / cell.total) * 100);
      console.log(`  ${row.model}  ${tier.padEnd(6)} ${cell.passed}/${cell.total} (${rate}%)`);
    }
  }

  console.log('\nToken usage (latest run per scenario):\n');
  for (const row of leaderboard) {
    console.log(
      `  ${row.model.padEnd(16)} avg=${String(row.avgTokens).padStart(6)}  total=${String(row.totalTokens).padStart(8)}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
