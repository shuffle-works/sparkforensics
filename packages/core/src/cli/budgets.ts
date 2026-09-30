import { computeEfficiencyModel } from '../efficiency-model.ts';
import { computeSkewRatio, ENTRY_BY_TYPE, type ThresholdOverrides } from '../detectors.ts';
import { effectiveThresholds } from '../threshold-overrides.ts';
import { IMPACT_BAND_ORDER } from '../format-utils.ts';
import type { CompareRunsResult } from '../run-comparison.ts';
import type { AppModel, Finding, ImpactBand } from '../types.ts';
import type { RegressionBudget } from './regression-budgets.ts';

const IMPACT_BANDS = Object.keys(IMPACT_BAND_ORDER) as ImpactBand[];

export interface BudgetsConfig {
  maxRuntimeMs?: number; maxSpillGb?: number; maxSkewRatio?: number;
  maxFailedTaskRatePct?: number; minEfficiencyPct?: number;
  maxRegressionPct?: number; regressionMetric?: string; failOnIntroduced?: string;
  /** Further regression budgets, one per metric, checked alongside the maxRegressionPct pair. */
  regressionBudgets?: RegressionBudget[];
}
export interface BudgetResult {
  name: 'max-runtime' | 'max-spill' | 'max-skew' | 'max-failed-task-rate' | 'min-efficiency'
    | 'max-regression' | 'fail-on-introduced' | 'run-complete';
  status: 'pass' | 'violation' | 'inconclusive';
  detail: string;
  /** Set on `max-regression` results: the metric key that budget checks. */
  metric?: string;
}

// The skew entry's minTasksForP95 under the run's overrides, so the budget measures the same
// ratio (P95/median or max/median) the skew finding reports.
function skewMinTasksForP95(thresholds: ThresholdOverrides | undefined): number {
  return effectiveThresholds(ENTRY_BY_TYPE.get('skew')!, thresholds).minTasksForP95 as number;
}

function taskDataTrusted(appModel: AppModel): boolean {
  const entry = appModel.evidenceAvailability?.entries?.find((e) => e.key === 'taskCoreTime');
  return entry?.state === 'present';
}

function maxFindingValue(catalog: Finding[], type: string): number | null {
  const values = catalog
    .filter((f) => f.type === type)
    .map((f) => f.value ?? 0);
  return values.length > 0 ? Math.max(...values) : null;
}

function checkRuntime(appModel: AppModel, maxRuntimeMs: number): BudgetResult {
  const { startTime, endTime } = appModel.app ?? {};
  if (startTime == null || endTime == null) {
    return { name: 'max-runtime', status: 'inconclusive', detail: 'App start/end time not observed (run may not have finished).' };
  }
  const runtimeMs = endTime - startTime;
  return runtimeMs > maxRuntimeMs
    ? { name: 'max-runtime', status: 'violation', detail: `Runtime ${runtimeMs}ms exceeds budget ${maxRuntimeMs}ms.` }
    : { name: 'max-runtime', status: 'pass', detail: `Runtime ${runtimeMs}ms within budget ${maxRuntimeMs}ms.` };
}

function checkSpill(appModel: AppModel, catalog: Finding[], maxSpillGb: number): BudgetResult {
  if (!taskDataTrusted(appModel)) {
    return { name: 'max-spill', status: 'inconclusive', detail: 'No trustworthy task-level evidence to measure spill.' };
  }
  const maxBytes = maxFindingValue(catalog, 'spill') ?? 0;
  const budgetBytes = maxSpillGb * 1024 ** 3;
  return maxBytes > budgetBytes
    ? { name: 'max-spill', status: 'violation', detail: `Peak stage spill ${maxBytes} bytes exceeds budget ${budgetBytes} bytes.` }
    : { name: 'max-spill', status: 'pass', detail: `Peak stage spill ${maxBytes} bytes within budget ${budgetBytes} bytes.` };
}

function checkSkew(appModel: AppModel, maxSkewRatio: number, minTasksForP95: number): BudgetResult {
  if (!taskDataTrusted(appModel)) {
    return { name: 'max-skew', status: 'inconclusive', detail: 'No trustworthy task-level evidence to measure skew.' };
  }
  const stages = [...(appModel.stages?.values() ?? [])];
  if (stages.length === 0) {
    return { name: 'max-skew', status: 'inconclusive', detail: 'No stage data observed in this event log.' };
  }
  // Recompute the true ratio per stage: the skew detector floors findings at
  // thresholds.ratioWarn (3), so a stricter budget can't be enforced from catalog alone.
  const ratios = stages
    .map((stage) => computeSkewRatio(stage, minTasksForP95))
    .filter((r) => r !== null)
    .map((r) => r.ratio);
  if (ratios.length === 0) {
    return { name: 'max-skew', status: 'inconclusive', detail: 'No stage has a measurable task-duration median.' };
  }
  const maxRatio = Math.max(...ratios);
  return maxRatio > maxSkewRatio
    ? { name: 'max-skew', status: 'violation', detail: `Peak stage skew ratio ${maxRatio} exceeds budget ${maxSkewRatio}.` }
    : { name: 'max-skew', status: 'pass', detail: `Peak stage skew ratio ${maxRatio} within budget ${maxSkewRatio}.` };
}

function checkFailedTaskRate(appModel: AppModel, catalog: Finding[], maxPct: number): BudgetResult {
  const finding = catalog.find((f) => f.type === 'jobFailureRate');
  if (finding) {
    const rate = (finding.taskFailureRate as number | undefined) ?? 0;
    return rate > maxPct
      ? { name: 'max-failed-task-rate', status: 'violation', detail: `Task failure rate ${rate}% exceeds budget ${maxPct}%.` }
      : { name: 'max-failed-task-rate', status: 'pass', detail: `Task failure rate ${rate}% within budget ${maxPct}%.` };
  }
  if ((appModel.jobs?.size ?? 0) === 0) {
    return { name: 'max-failed-task-rate', status: 'inconclusive', detail: 'No job data observed in this event log.' };
  }
  // jobFailureRate never fired => rate below its 10% info floor, so task failure rate is
  // implicitly low. v1 limitation: a budget stricter than that floor can't be enforced.
  return { name: 'max-failed-task-rate', status: 'pass', detail: `No job-failure-rate finding: task failure rate is below the detector's reporting floor.` };
}

// Busy core time: the share of available executor core time that ran tasks, 100 minus the
// dashboard's "Unused core time". Not the dashboard's Efficiency tile (the share of wall-clock with
// a stage running), so the detail never calls it "Efficiency".
function checkEfficiency(appModel: AppModel, minPct: number): BudgetResult {
  if (!taskDataTrusted(appModel)) {
    return { name: 'min-efficiency', status: 'inconclusive', detail: 'No trustworthy task-level evidence to measure busy core time.' };
  }
  const model = computeEfficiencyModel({
    app: appModel.app, stages: appModel.stages,
    executorsAdded: appModel.executors.added, executorsRemoved: appModel.executors.removed,
    runAggregates: appModel.runAggregates,
  });
  if (model.wastagePct == null) {
    return { name: 'min-efficiency', status: 'inconclusive', detail: 'Busy core time could not be computed (no available compute hours).' };
  }
  const busyCorePct = 100 - model.wastagePct;
  return busyCorePct < minPct
    ? { name: 'min-efficiency', status: 'violation', detail: `Busy core time ${busyCorePct}% below budget ${minPct}%.` }
    : { name: 'min-efficiency', status: 'pass', detail: `Busy core time ${busyCorePct}% meets budget ${minPct}%.` };
}

function checkRegression(comparison: CompareRunsResult, maxRegressionPct: number, regressionMetric: string): BudgetResult {
  const row = comparison.metrics.find((m) => m.key === regressionMetric);
  if (!row || row.direction === 'unavailable' || row.baseline == null || row.delta == null) {
    return { name: 'max-regression', metric: regressionMetric, status: 'inconclusive', detail: `Metric "${regressionMetric}" is unavailable for this comparison.` };
  }
  // A neutral-direction metric (inputBytes/outputBytes/taskCount/executorsAdded) measures
  // workload volume, not performance: an increase isn't a regression, so no direction to check.
  if (row.direction === 'neutral') {
    return { name: 'max-regression', metric: regressionMetric, status: 'inconclusive', detail: `Metric "${regressionMetric}" measures workload volume, not performance: it has no regression direction to check.` };
  }
  if (row.direction !== 'regression') {
    return { name: 'max-regression', metric: regressionMetric, status: 'pass', detail: `Metric "${regressionMetric}" did not regress (${row.direction}).` };
  }
  const pct = row.baseline === 0 ? Infinity : Math.abs(row.delta / row.baseline) * 100;
  const pctLabel = row.baseline === 0
    ? `regressed from 0 to ${row.delta} (was absent/zero in baseline)`
    : `regressed ${pct.toFixed(1)}%`;
  return pct > maxRegressionPct
    ? { name: 'max-regression', metric: regressionMetric, status: 'violation', detail: `Metric "${regressionMetric}" ${pctLabel}, exceeding budget ${maxRegressionPct}%.` }
    : { name: 'max-regression', metric: regressionMetric, status: 'pass', detail: `Metric "${regressionMetric}" ${pctLabel}, within budget ${maxRegressionPct}%.` };
}

function checkFailOnIntroduced(comparison: CompareRunsResult, band: string): BudgetResult {
  if (band !== 'all' && !IMPACT_BANDS.includes(band as ImpactBand)) {
    return { name: 'fail-on-introduced', status: 'inconclusive', detail: `Impact band "${band}" is not recognized (expected "all" or one of ${IMPACT_BANDS.join(', ')}).` };
  }
  const matches = band === 'all'
    ? comparison.findings.introduced
    : comparison.findings.introduced.filter((f) => f.impactBand === band);
  return matches.length > 0
    ? { name: 'fail-on-introduced', status: 'violation', detail: `${matches.length} introduced finding(s) match "${band}".` }
    : { name: 'fail-on-introduced', status: 'pass', detail: `No introduced findings match "${band}".` };
}

// Both comparison-dependent budgets share the "no comparison yet -> inconclusive" fallback.
function pushComparisonBudget(
  results: BudgetResult[],
  comparison: CompareRunsResult | undefined,
  name: BudgetResult['name'],
  check: (comparison: CompareRunsResult) => BudgetResult,
  metric?: string,
): void {
  results.push(comparison ? check(comparison) : {
    name, status: 'inconclusive', detail: 'No baseline comparison available to evaluate this budget.',
    ...(metric !== undefined ? { metric } : {}),
  });
}

/** `thresholds`: the overrides the catalog was analyzed with, so a budget that recomputes a
 * detector's figure (--max-skew) uses the same thresholds. */
export function evaluateBudgets({ appModel, catalog, budgets, comparison, thresholds }: {
  appModel: AppModel; catalog: Finding[]; budgets: BudgetsConfig; comparison?: CompareRunsResult;
  thresholds?: ThresholdOverrides;
}): { results: BudgetResult[]; violated: boolean; inconclusive: boolean } {
  const results: BudgetResult[] = [];
  if (Number.isFinite(budgets.maxRuntimeMs)) results.push(checkRuntime(appModel, budgets.maxRuntimeMs!));
  if (Number.isFinite(budgets.maxSpillGb)) results.push(checkSpill(appModel, catalog, budgets.maxSpillGb!));
  if (Number.isFinite(budgets.maxSkewRatio)) results.push(checkSkew(appModel, budgets.maxSkewRatio!, skewMinTasksForP95(thresholds)));
  if (Number.isFinite(budgets.maxFailedTaskRatePct)) results.push(checkFailedTaskRate(appModel, catalog, budgets.maxFailedTaskRatePct!));
  if (Number.isFinite(budgets.minEfficiencyPct)) results.push(checkEfficiency(appModel, budgets.minEfficiencyPct!));
  // Guarded here so any evaluateBudgets caller benefits: regressionMetric without
  // maxRegressionPct would otherwise skip the `if` silently, reporting nothing.
  if (budgets.regressionMetric !== undefined && budgets.maxRegressionPct === undefined) {
    results.push({ name: 'max-regression', metric: budgets.regressionMetric, status: 'inconclusive', detail: `regressionMetric "${budgets.regressionMetric}" was set without maxRegressionPct; the regression budget was not evaluated.` });
  } else if (budgets.maxRegressionPct !== undefined) {
    // `!== undefined`, not Number.isFinite: a zero-baseline regression's pct is Infinity,
    // so an "unlimited" budget is a legitimate input (the CLI already rejects non-finite flags).
    pushComparisonBudget(results, comparison, 'max-regression',
      (c) => checkRegression(c, budgets.maxRegressionPct!, budgets.regressionMetric ?? 'wallClock'),
      budgets.regressionMetric ?? 'wallClock');
  }
  for (const { metric, maxPct } of budgets.regressionBudgets ?? []) {
    pushComparisonBudget(results, comparison, 'max-regression', (c) => checkRegression(c, maxPct, metric), metric);
  }
  if (budgets.failOnIntroduced !== undefined) {
    pushComparisonBudget(results, comparison, 'fail-on-introduced',
      (c) => checkFailOnIntroduced(c, budgets.failOnIntroduced!));
  }
  // Always checked, unlike the opt-in budgets above: a run with no ApplicationEnd is
  // inconclusive by default, so a passing budget can't hide a truncated log.
  const incompleteRunFinding = catalog.find((f) => f.type === 'incompleteRun');
  if (incompleteRunFinding) {
    results.push({ name: 'run-complete', status: 'inconclusive', detail: incompleteRunFinding.recommendation ?? 'Event log has no ApplicationEnd event.' });
  }
  return {
    results,
    violated: results.some((r) => r.status === 'violation'),
    inconclusive: results.some((r) => r.status === 'inconclusive'),
  };
}
