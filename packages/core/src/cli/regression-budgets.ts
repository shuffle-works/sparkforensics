// Parses the regression budgets a CLI caller lists: repeated `--regression-budget <metric>:<pct>`
// flags and a `--budgets <file.json>` file. Every failure throws an Error naming the problem, so
// the caller refuses to run (exit 2) instead of quietly dropping a budget the user meant to gate on.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMPARISON_METRIC_KEYS } from '../run-comparison.ts';
import { PAIR_DELTA_METRICS } from '../stage-alignment.ts';
import { STAGE_QUALITIES } from './budgets.ts';
import type { StagePair } from '../stage-alignment.ts';

export interface RegressionBudget { metric: string; maxPct: number; }
export interface RegressionBudgetSource { origin: string; budget: RegressionBudget; }

// Plain non-negative decimals only: Number() would also accept '', ' ', '0x10' and '1e3'.
const PCT_PATTERN = /^\d+(\.\d+)?$/;

function assertKnownMetric(metric: string, origin: string): void {
  if (!COMPARISON_METRIC_KEYS.includes(metric)) {
    throw new Error(`${origin}: unknown metric "${metric}" (expected one of: ${COMPARISON_METRIC_KEYS.join(', ')}).`);
  }
}

/** One `--regression-budget` value, `<metric>:<pct>`. */
export function parseRegressionBudgetFlag(spec: string): RegressionBudget {
  const origin = `--regression-budget "${spec}"`;
  const colon = spec.indexOf(':');
  if (colon === -1) throw new Error(`${origin}: expected <metric>:<pct>.`);
  const metric = spec.slice(0, colon);
  const pct = spec.slice(colon + 1);
  assertKnownMetric(metric, origin);
  if (!PCT_PATTERN.test(pct)) throw new Error(`${origin}: "${pct}" is not a non-negative percentage.`);
  return { metric, maxPct: Number(pct) };
}

/** The parsed `--budgets` JSON: `{"regression": {"<metric>": <pct>}}`. */
export function parseBudgetsFile(raw: unknown, origin: string): RegressionBudget[] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${origin}: expected a JSON object like {"regression": {"wallClock": 10}}.`);
  }
  const unknownKeys = Object.keys(raw).filter((k) => k !== 'regression');
  if (unknownKeys.length > 0) {
    throw new Error(`${origin}: unknown key ${unknownKeys.map((k) => `"${k}"`).join(', ')} (the only key is "regression").`);
  }
  const regression = (raw as { regression?: unknown }).regression;
  if (regression === null || typeof regression !== 'object' || Array.isArray(regression)) {
    throw new Error(`${origin}: "regression" must be an object mapping a metric key to a percentage.`);
  }
  return Object.entries(regression).map(([metric, pct]) => {
    assertKnownMetric(metric, origin);
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0) {
      throw new Error(`${origin}: "${metric}" must be a non-negative number (a percentage), got ${JSON.stringify(pct)}.`);
    }
    return { metric, maxPct: pct };
  });
}

export function loadBudgetsFile(path: string): RegressionBudget[] {
  const fullPath = resolve(path);
  let text: string;
  try {
    text = readFileSync(fullPath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read budgets file ${fullPath}: ${(e as Error).message}`, { cause: e });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`Budgets file ${fullPath} is not valid JSON: ${(e as Error).message}`, { cause: e });
  }
  return parseBudgetsFile(raw, `Budgets file ${fullPath}`);
}

/** Checks that no metric is budgeted twice across the sources (the legacy
 * `--max-regression-pct`/`--regression-metric` pair counts as one), and returns the budgets. */
export function combineRegressionBudgets(sources: RegressionBudgetSource[]): RegressionBudget[] {
  const seen = new Map<string, string>();
  for (const { origin, budget } of sources) {
    const first = seen.get(budget.metric);
    if (first !== undefined) {
      throw new Error(`Metric "${budget.metric}" has two regression budgets (${first} and ${origin}); give each metric one.`);
    }
    seen.set(budget.metric, origin);
  }
  return sources.map((s) => s.budget);
}

/** One `--stage-regression-budget` value, `<metric>:<pct>`, over the paired-stage metrics. */
export function parseStageRegressionBudgetFlag(spec: string): RegressionBudget {
  const origin = `--stage-regression-budget "${spec}"`;
  const colon = spec.indexOf(':');
  if (colon === -1) throw new Error(`${origin}: expected <metric>:<pct>.`);
  const metric = spec.slice(0, colon);
  const pct = spec.slice(colon + 1);
  if (!(PAIR_DELTA_METRICS as readonly string[]).includes(metric)) {
    throw new Error(`${origin}: unknown paired-stage metric "${metric}" (expected one of: ${PAIR_DELTA_METRICS.join(', ')}).`);
  }
  if (!PCT_PATTERN.test(pct)) throw new Error(`${origin}: "${pct}" is not a non-negative percentage.`);
  return { metric, maxPct: Number(pct) };
}

/** The pair qualities a stage budget reads, from a comma list such as `exact,structural`. */
export function parseStageQualities(list: string, origin: string): StagePair['quality'][] {
  const qualities = list.split(',').map((q) => q.trim()).filter(Boolean);
  const bad = qualities.find((q) => !(STAGE_QUALITIES as readonly string[]).includes(q));
  if (qualities.length === 0 || bad !== undefined) {
    throw new Error(`${origin}: ${bad === undefined ? 'no quality given' : `unknown quality "${bad}"`} (expected a list from: ${STAGE_QUALITIES.join(', ')}).`);
  }
  return qualities as StagePair['quality'][];
}
