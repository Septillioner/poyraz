import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DIFFICULTY_ORDER,
  PASS_THRESHOLD,
  type EvalDifficulty,
  type EvalResult,
} from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, 'results');
const REPORTS_DIR = path.join(__dirname, 'reports');

interface RunSummary {
  model: string;
  runStamp: string;
  label: string;
  passRate: number;
  passed: number;
  total: number;
  totalTokens: number;
  avgTokens: number;
  tokensByDifficulty: Record<EvalDifficulty, number>;
}

interface ScenarioPoint {
  runStamp: string;
  label: string;
  composite: number;
  passed: boolean;
}

interface ScenarioSeries {
  scenarioId: string;
  model: string;
  points: ScenarioPoint[];
}

interface HeatmapCell {
  model: string;
  scenarioId: string;
  passed: boolean | null;
  composite: number | null;
  runStamp: string | null;
}

function compositeOf(result: EvalResult): number {
  return result.composite ?? Math.round((result.traceScore + result.outcomeScore + result.efficiencyScore) / 3);
}

function passedOf(result: EvalResult): boolean {
  return result.passed ?? compositeOf(result) >= PASS_THRESHOLD;
}

function difficultyOf(result: EvalResult): EvalDifficulty {
  return result.difficulty ?? 'medium';
}

function parseCliArgs(): { model?: string; output?: string; last: number } {
  const argv = process.argv.slice(2);
  const positional: string[] = [];
  let model: string | undefined;
  let output: string | undefined;
  let last = 5;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--model=')) {
      model = arg.slice('--model='.length);
      continue;
    }
    if (arg === '--model' && argv[i + 1]) {
      model = argv[++i];
      continue;
    }
    if (arg.startsWith('--output=')) {
      output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--output' && argv[i + 1]) {
      output = argv[++i];
      continue;
    }
    if (arg.startsWith('--last=')) {
      last = Number(arg.slice('--last='.length));
      continue;
    }
    if (arg === '--last' && argv[i + 1]) {
      last = Number(argv[++i]);
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  if (!model && positional[0] && !positional[0].includes('/') && !positional[0].endsWith('.html')) {
    model = positional[0];
  }
  if (!output) {
    const outputCandidate = positional.find((p) => p.endsWith('.html') || p.includes('/'));
    if (outputCandidate) output = outputCandidate;
  }

  return { model, output, last };
}

function formatRunLabel(runStamp: string): string {
  const match = runStamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/);
  if (match) return `${match[1]} ${match[2]}:${match[3]}`;
  return runStamp;
}

async function loadResults(modelFilter?: string): Promise<{ results: EvalResult[]; runs: Map<string, EvalResult[]> }> {
  const modelDirs = await fs.readdir(RESULTS_DIR).catch(() => [] as string[]);
  const allResults: EvalResult[] = [];
  const runs = new Map<string, EvalResult[]>();

  for (const model of modelDirs) {
    if (modelFilter && model !== modelFilter) continue;
    const full = path.join(RESULTS_DIR, model);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat?.isDirectory()) continue;

    const entries = await fs.readdir(full).catch(() => [] as string[]);
    for (const file of entries.filter((f) => f.endsWith('.json'))) {
      const runStamp = file.replace(/\.json$/, '');
      const raw = await fs.readFile(path.join(full, file), 'utf-8');
      const batch = JSON.parse(raw) as EvalResult[];
      const runKey = `${model}::${runStamp}`;
      runs.set(runKey, batch);
      allResults.push(...batch);
    }
  }

  allResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { results: allResults, runs };
}

function buildRunSummaries(runs: Map<string, EvalResult[]>): RunSummary[] {
  const summaries: RunSummary[] = [];

  for (const [runKey, batch] of runs) {
    if (batch.length === 0) continue;
    const [model, runStamp] = runKey.split('::');
    const passed = batch.filter((r) => passedOf(r)).length;
    const totalTokens = batch.reduce((s, r) => s + (r.metrics?.totalTokens ?? 0), 0);
    const tokensByDifficulty = {} as Record<EvalDifficulty, number>;
    for (const tier of DIFFICULTY_ORDER) {
      tokensByDifficulty[tier] = batch
        .filter((r) => difficultyOf(r) === tier)
        .reduce((s, r) => s + (r.metrics?.totalTokens ?? 0), 0);
    }

    summaries.push({
      model,
      runStamp,
      label: formatRunLabel(runStamp),
      passRate: Math.round((passed / batch.length) * 100),
      passed,
      total: batch.length,
      totalTokens,
      avgTokens: Math.round(totalTokens / batch.length),
      tokensByDifficulty,
    });
  }

  return summaries.sort((a, b) => a.runStamp.localeCompare(b.runStamp));
}

function buildScenarioSeries(results: EvalResult[]): ScenarioSeries[] {
  const byKey = new Map<string, EvalResult[]>();
  for (const result of results) {
    const key = `${result.model}::${result.scenarioId}`;
    const list = byKey.get(key) ?? [];
    list.push(result);
    byKey.set(key, list);
  }

  const series: ScenarioSeries[] = [];
  for (const [key, list] of byKey) {
    const [model, scenarioId] = key.split('::');
    const sorted = [...list].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    const seen = new Set<string>();
    const points: ScenarioPoint[] = [];

    for (const result of sorted) {
      const runStamp = result.timestamp.slice(0, 19).replace(/:/g, '-');
      const dedupeKey = runStamp;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      points.push({
        runStamp,
        label: formatRunLabel(runStamp),
        composite: compositeOf(result),
        passed: passedOf(result),
      });
    }

    if (points.length > 0) {
      series.push({ scenarioId, model, points });
    }
  }

  return series.sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
}

function latestPerModelScenario(results: EvalResult[]): HeatmapCell[] {
  const map = new Map<string, EvalResult>();
  for (const result of results) {
    const key = `${result.model}::${result.scenarioId}`;
    const existing = map.get(key);
    if (!existing || result.timestamp > existing.timestamp) {
      map.set(key, result);
    }
  }

  return [...map.values()].map((r) => ({
    model: r.model,
    scenarioId: r.scenarioId,
    passed: passedOf(r),
    composite: compositeOf(r),
    runStamp: r.timestamp.slice(0, 19).replace(/:/g, '-'),
  }));
}

function chartPalette(n: number): string[] {
  const base = [
    '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#8b5cf6',
    '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
    '#14b8a6', '#e11d48', '#a855f7', '#0ea5e9', '#65a30d',
  ];
  return Array.from({ length: n }, (_, i) => base[i % base.length]);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHeatmapHtml(cells: HeatmapCell[]): string {
  const models = [...new Set(cells.map((c) => c.model))].sort();
  const scenarios = [...new Set(cells.map((c) => c.scenarioId))].sort();
  const cellMap = new Map(cells.map((c) => [`${c.model}::${c.scenarioId}`, c]));

  const header = `<tr><th>Scenario</th>${models.map((m) => `<th>${escapeHtml(m)}</th>`).join('')}</tr>`;
  const rows = scenarios.map((scenarioId) => {
    const cellsHtml = models.map((model) => {
      const cell = cellMap.get(`${model}::${scenarioId}`);
      if (!cell) {
        return '<td class="cell nodata" title="No data">—</td>';
      }
      const cls = cell.passed ? 'pass' : 'fail';
      const title = `${model} / ${scenarioId}: ${cell.composite} (${cell.passed ? 'PASS' : 'FAIL'})`;
      return `<td class="cell ${cls}" title="${escapeHtml(title)}">${cell.composite}</td>`;
    }).join('');
    return `<tr><th class="scenario-label">${escapeHtml(scenarioId)}</th>${cellsHtml}</tr>`;
  }).join('');

  return `<table class="heatmap">${header}${rows}</table>`;
}

function buildHtml(opts: {
  generatedAt: string;
  modelFilter?: string;
  lastN: number;
  runSummaries: RunSummary[];
  scenarioSeries: ScenarioSeries[];
  heatmapCells: HeatmapCell[];
  totalResults: number;
}): string {
  const { generatedAt, modelFilter, lastN, runSummaries, scenarioSeries, heatmapCells, totalResults } = opts;
  const models = [...new Set(runSummaries.map((r) => r.model))].sort();
  const runLabelOrder = runSummaries.map((r) => r.label).filter((v, i, a) => a.indexOf(v) === i);

  const passRateDatasets = models.map((model, i) => {
    const color = chartPalette(models.length)[i];
    const data = runLabelOrder.map((label) => {
      const run = runSummaries.find((r) => r.model === model && r.label === label);
      return run?.passRate ?? null;
    });
    return { label: model, data, borderColor: color, backgroundColor: color + '33', tension: 0.2, spanGaps: true };
  });

  const topScenarios = [...new Set(scenarioSeries.map((s) => s.scenarioId))].slice(0, 12);
  const scenarioDatasets = topScenarios.map((scenarioId, i) => {
    const color = chartPalette(topScenarios.length)[i];
    const series = scenarioSeries.filter((s) => s.scenarioId === scenarioId);
    const allLabels = [...new Set(series.flatMap((s) => s.points.map((p) => p.label)))];
    const data = allLabels.map((label) => {
      const point = series.flatMap((s) => s.points).find((p) => p.label === label);
      return point?.composite ?? null;
    });
    return { label: scenarioId, data, borderColor: color, backgroundColor: color + '22', tension: 0.2, spanGaps: true };
  });
  const scenarioLabels = [...new Set(scenarioSeries.flatMap((s) => s.points.map((p) => p.label)))].sort();

  const tokenRunDatasets = models.map((model, i) => {
    const color = chartPalette(models.length)[i];
    const data = runLabelOrder.map((label) => {
      const run = runSummaries.find((r) => r.model === model && r.label === label);
      return run?.totalTokens ?? null;
    });
    return { label: model, data, backgroundColor: color + 'cc' };
  });

  const tokenDifficultyLabels = runLabelOrder;
  const tokenDifficultyDatasets = DIFFICULTY_ORDER.flatMap((tier) =>
    models.map((model, i) => {
      const color = chartPalette(DIFFICULTY_ORDER.length)[DIFFICULTY_ORDER.indexOf(tier)];
      const data = runLabelOrder.map((label) => {
        const run = runSummaries.find((r) => r.model === model && r.label === label);
        return run?.tokensByDifficulty[tier] ?? 0;
      });
      return {
        label: `${model} (${tier})`,
        data,
        backgroundColor: color + (models.length > 1 ? ['cc', '99', '66'][i % 3] : 'cc'),
        stack: model,
      };
    })
  ).filter((ds) => ds.data.some((v) => v > 0));

  const filterNote = modelFilter ? `Filtered to model: <strong>${escapeHtml(modelFilter)}</strong>` : 'All models';
  const heatmapHtml = buildHeatmapHtml(heatmapCells);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Poyraz Eval History Report</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --border: #334155;
      --pass: #166534;
      --fail: #991b1b;
      --nodata: #475569;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    header {
      padding: 1.5rem 2rem;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }
    header h1 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    header p { margin: 0; color: var(--muted); font-size: 0.9rem; }
    main { padding: 1.5rem 2rem 3rem; max-width: 1400px; margin: 0 auto; }
    .grid { display: grid; gap: 1.5rem; grid-template-columns: 1fr; }
    @media (min-width: 1100px) {
      .grid-2 { grid-template-columns: 1fr 1fr; }
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.25rem 1.25rem;
    }
    .card h2 { margin: 0 0 0.25rem; font-size: 1.1rem; }
    .card .subtitle { margin: 0 0 1rem; color: var(--muted); font-size: 0.85rem; }
    .chart-wrap { position: relative; height: 320px; }
    .chart-wrap.tall { height: 420px; }
    .heatmap-wrap { overflow-x: auto; }
    table.heatmap {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.8rem;
    }
    table.heatmap th, table.heatmap td {
      border: 1px solid var(--border);
      padding: 0.35rem 0.5rem;
      text-align: center;
      white-space: nowrap;
    }
    table.heatmap th.scenario-label { text-align: left; font-weight: 500; }
    table.heatmap th { background: #0f172a; color: var(--muted); font-weight: 600; }
    td.cell.pass { background: var(--pass); color: #bbf7d0; font-weight: 600; }
    td.cell.fail { background: var(--fail); color: #fecaca; font-weight: 600; }
    td.cell.nodata { background: var(--nodata); color: var(--muted); }
    .legend { display: flex; gap: 1rem; margin-top: 0.75rem; font-size: 0.8rem; color: var(--muted); }
    .legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
    .swatch { width: 14px; height: 14px; border-radius: 3px; display: inline-block; }
    .swatch.pass { background: var(--pass); }
    .swatch.fail { background: var(--fail); }
    .swatch.nodata { background: var(--nodata); }
    .stats {
      display: flex; flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem;
    }
    .stat {
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; padding: 0.75rem 1rem; min-width: 140px;
    }
    .stat .value { font-size: 1.4rem; font-weight: 700; }
    .stat .label { font-size: 0.8rem; color: var(--muted); }
  </style>
</head>
<body>
  <header>
    <h1>Poyraz Eval History</h1>
    <p>${filterNote} &middot; ${totalResults} scenario results &middot; Generated ${escapeHtml(generatedAt)}</p>
  </header>
  <main>
    <div class="stats">
      <div class="stat"><div class="value">${models.length}</div><div class="label">Models</div></div>
      <div class="stat"><div class="value">${runSummaries.length}</div><div class="label">Runs</div></div>
      <div class="stat"><div class="value">${[...new Set(scenarioSeries.map((s) => s.scenarioId))].length}</div><div class="label">Scenarios</div></div>
      <div class="stat"><div class="value">${lastN}</div><div class="label">Heatmap window (latest)</div></div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <h2>Pass Rate Over Runs</h2>
        <p class="subtitle">Percentage of scenarios passed (composite &ge; ${PASS_THRESHOLD}) per eval run</p>
        <div class="chart-wrap"><canvas id="passRateChart"></canvas></div>
      </div>
      <div class="card">
        <h2>Token Usage Per Run</h2>
        <p class="subtitle">Total tokens consumed across all scenarios in each run</p>
        <div class="chart-wrap"><canvas id="tokenRunChart"></canvas></div>
      </div>
    </div>

    <div class="card" style="margin-top: 1.5rem;">
      <h2>Composite Score by Scenario</h2>
      <p class="subtitle">Top ${topScenarios.length} scenarios — composite score trend across runs (all models overlaid per scenario)</p>
      <div class="chart-wrap tall"><canvas id="scenarioChart"></canvas></div>
    </div>

    <div class="card" style="margin-top: 1.5rem;">
      <h2>Token Usage by Difficulty Tier</h2>
      <p class="subtitle">Stacked tokens per difficulty within each run</p>
      <div class="chart-wrap tall"><canvas id="tokenDifficultyChart"></canvas></div>
    </div>

    <div class="card" style="margin-top: 1.5rem;">
      <h2>Scenario Heatmap (Latest Run)</h2>
      <p class="subtitle">Model &times; scenario — cell shows composite score; color = pass/fail on most recent run</p>
      <div class="heatmap-wrap">${heatmapHtml}</div>
      <div class="legend">
        <span><i class="swatch pass"></i> Pass (&ge;${PASS_THRESHOLD})</span>
        <span><i class="swatch fail"></i> Fail (&lt;${PASS_THRESHOLD})</span>
        <span><i class="swatch nodata"></i> No data</span>
      </div>
    </div>
  </main>

  <script>
    const chartDefaults = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#cbd5e1' } },
      },
      scales: {
        x: { ticks: { color: '#94a3b8', maxRotation: 45 }, grid: { color: '#334155' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
      },
    };

    new Chart(document.getElementById('passRateChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(runLabelOrder)},
        datasets: ${JSON.stringify(passRateDatasets)},
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: { ...chartDefaults.scales.y, min: 0, max: 100, title: { display: true, text: 'Pass %', color: '#94a3b8' } },
        },
      },
    });

    new Chart(document.getElementById('tokenRunChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(runLabelOrder)},
        datasets: ${JSON.stringify(tokenRunDatasets)},
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: { ...chartDefaults.scales.y, title: { display: true, text: 'Total tokens', color: '#94a3b8' } },
        },
      },
    });

    new Chart(document.getElementById('scenarioChart'), {
      type: 'line',
      data: {
        labels: ${JSON.stringify(scenarioLabels)},
        datasets: ${JSON.stringify(scenarioDatasets)},
      },
      options: {
        ...chartDefaults,
        scales: {
          ...chartDefaults.scales,
          y: { ...chartDefaults.scales.y, min: 0, max: 100, title: { display: true, text: 'Composite', color: '#94a3b8' } },
        },
      },
    });

    new Chart(document.getElementById('tokenDifficultyChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(tokenDifficultyLabels)},
        datasets: ${JSON.stringify(tokenDifficultyDatasets)},
      },
      options: {
        ...chartDefaults,
        scales: {
          x: { ...chartDefaults.scales.x, stacked: true },
          y: { ...chartDefaults.scales.y, stacked: true, title: { display: true, text: 'Tokens', color: '#94a3b8' } },
        },
      },
    });
  </script>
</body>
</html>`;
}

async function main(): Promise<void> {
  const { model: modelFilter, output: outputArg, last: lastN } = parseCliArgs();

  const { results, runs } = await loadResults(modelFilter);
  if (results.length === 0) {
    console.log('No eval results found in evals/results/');
    return;
  }

  const runSummaries = buildRunSummaries(runs);
  const scenarioSeries = buildScenarioSeries(results);
  const heatmapCells = latestPerModelScenario(results);

  const now = new Date();
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-');
  const generatedAt = now.toISOString();

  await fs.mkdir(REPORTS_DIR, { recursive: true });

  const html = buildHtml({
    generatedAt,
    modelFilter,
    lastN,
    runSummaries,
    scenarioSeries,
    heatmapCells,
    totalResults: results.length,
  });

  const timestampPath = path.join(REPORTS_DIR, `${stamp}.html`);
  const latestPath = path.join(REPORTS_DIR, 'latest.html');
  const outputPath = outputArg
    ? path.resolve(process.cwd(), outputArg)
    : timestampPath;

  await fs.writeFile(outputPath, html, 'utf-8');
  if (outputPath !== latestPath) {
    await fs.writeFile(latestPath, html, 'utf-8');
  }
  if (outputPath !== timestampPath && !outputArg?.includes('latest')) {
    await fs.writeFile(timestampPath, html, 'utf-8');
  }

  console.log(`Eval visualization written to: ${outputPath}`);
  console.log(`Also available at: ${latestPath}`);
  console.log(`Open in browser: file:///${outputPath.replace(/\\/g, '/')}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
