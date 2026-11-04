import { describe, it, expect } from 'vitest';
import { auditConfig } from '../src/analyzer.ts';
import { analyzeRun } from '../src/analyzed-run.ts';
import { checkCoverage } from '../src/check-coverage.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { impactEstimateCompact, impactEstimateFigure, impactFigure } from '../src/impact-format.ts';
import { isCaveat, rankedRollup } from '../src/recommendation-rollup.ts';
import { interpretRun } from '../src/run-interpretation.ts';
import { computeRunShape } from '../src/run-shape.ts';
import { buildRunVerdict, FINDING_DISPLAY_ORDER } from '../src/run-verdict.ts';
import { makeApp, makeTypedStage } from './fixtures/stage-app-fixtures.js';
import { analyzedRunFrom } from './fixtures/analyzed-run.js';

/** @typedef {import('../src/types.ts').Finding} Finding */

/**
 * @param {'spill' | 'skew' | 'gc' | 'straggler'} type
 * @param {number} stageId
 * @param {number} highMs
 * @param {import('../src/types.ts').ImpactBand} [impactBand]
 * @returns {Finding}
 */
function timed(type, stageId, highMs, impactBand = 'warning') {
  const base = {
    id: `${type}-${stageId}`, stageId, impactBand, recommendation: `Fix ${type} in Stage ${stageId}.`,
    /** @type {import('../src/types.ts').ImpactEstimate} */
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'modeled' },
  };
  if (type === 'straggler') return { ...base, type, unit: 'count', speculativeTasks: 0, stragglerCount: 0 };
  return { ...base, type };
}

/** @param {Partial<import('../src/types.ts').AppModel>} [overrides] @returns {import('../src/types.ts').AppModel} */
function appModel(overrides = {}) {
  return {
    app: makeApp({ startTime: 0, endTime: 20_000 }),
    stages: new Map([[7, makeTypedStage({ id: 7, submittedAt: 0, completedAt: 15_000 })], [3, makeTypedStage({ id: 3 })]]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
    ...overrides,
  };
}

/** @param {number} id @param {number[]} stageIds @returns {import('../src/types.ts').Job} */
const failedJob = (id, stageIds) => ({
  id, submissionTime: 0, stageIds, sqlExecutionId: null, result: 'JobFailed', succeeded: false, exception: null, completionTime: 1,
});

describe('idle share grading', () => {
  // 4 cores for 20s hold 80s of core time and 16s of it ran tasks: 80% idle.
  const idleModel = () => appModel({
    executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, host: 'host-1', totalCores: 4, resourceProfileId: null }], removed: [] },
    runAggregates: { busyCoreMs: 16_000, perStage: {} },
  });
  const note = "80% of the run's core time went unused, so the cluster may be larger than this job needs.";

  it('flags the Scorecard tile and notes the verdict from the utilization thresholds', () => {
    const interpretation = interpretRun(idleModel(), [], []);
    expect(interpretation.runShape).toMatchObject({ unusedCoreTimePct: 80, unusedCoreTimeFlag: 'critical' });
    expect(interpretation.verdict.summary).toContain(note);
  });

  it('moves the tile flag and the verdict note together under a --thresholds override', () => {
    const interpretation = interpretRun(idleModel(), [], [], { utilization: { minUtil: 0.1, criticalUtil: 0.05 } });
    expect(interpretation.runShape.unusedCoreTimeFlag).toBeNull();
    expect(interpretation.verdict.summary).not.toContain(note);
  });
});

describe('interpretRun', () => {
  it('refers to findings by id, with savings keyed by id', () => {
    /** @type {Finding[]} */
    const catalog = [timed('spill', 3, 1_000), timed('skew', 7, 2_400)];
    /** @type {Finding[]} */
    const config = [{ id: 'config-serializer', type: 'configAudit', property: 'spark.serializer', valueText: 'unset', stageId: null, impactBand: 'info', recommendation: 'Use Kryo.' }];
    const interpretation = interpretRun(appModel(), catalog, config);
    const byId = new Map([...catalog, ...config].map((finding) => [finding.id, finding]));

    expect(Object.keys(interpretation.savings).sort()).toEqual(['config-serializer', 'skew-7', 'spill-3']);
    const skewId = catalog[1].id;
    if (skewId === undefined) throw new Error('the skew finding has no id');
    expect(interpretation.savings[skewId]).toEqual({
      figure: impactFigure(catalog[1]),
      meaning: 'of run time',
      board: impactEstimateFigure(catalog[1].impactEstimate)?.text,
      compact: impactEstimateCompact(catalog[1].impactEstimate),
      provenance: expect.stringContaining('point estimate'),
    });
    expect(interpretation.savings['config-serializer'].figure).toBeNull();
    // The info config note stays out of the steps: it is context, never something to act on.
    expect(interpretation.verdict.steps.map((step) => byId.get(step.leadId))).toEqual([catalog[1], catalog[0]]);
    expect(interpretation.savingsRank.map((id) => byId.get(id))).toEqual([catalog[1], catalog[0], config[0]]);
  });

  it('gives the same conclusions whatever order the findings arrive in', () => {
    /** @type {Finding[]} */
    const catalog = [timed('spill', 3, 1_000), timed('skew', 7, 2_400), timed('gc', 7, 500, 'critical')];
    /** @type {Finding[]} */
    const config = [{ id: 'config-serializer', type: 'configAudit', property: 'spark.serializer', valueText: 'unset', stageId: null, impactBand: 'info', recommendation: 'Use Kryo.' }];
    const forward = interpretRun(appModel(), catalog, config);
    const shuffled = interpretRun(appModel(), [catalog[2], catalog[0], catalog[1]], config);

    expect(shuffled.verdict.steps.map((step) => step.leadId)).toEqual(forward.verdict.steps.map((step) => step.leadId));
    expect(shuffled.savingsRank).toEqual(forward.savingsRank);
    expect(shuffled.savings).toEqual(forward.savings);
    expect(shuffled.stages['7'].findingIds.slice().sort()).toEqual(forward.stages['7'].findingIds.slice().sort());
  });

  it('refuses a finding without an id, which nothing could point at', () => {
    expect(() => interpretRun(appModel(), [{ type: 'skew', stageId: 7, impactBand: 'warning' }], [])).toThrow(/skew finding has no id/);
  });

  it('words the verdict exactly as buildRunVerdict does', () => {
    const model = appModel();
    /** @type {Finding[]} */
    const catalog = [timed('skew', 7, 2_400), timed('straggler', 7, 2_300), timed('spill', 3, 1_000)];
    const expected = buildRunVerdict(model, catalog);
    const { verdict } = interpretRun(model, catalog, []);

    expect(verdict.title).toBe(expected.title);
    expect(verdict.summary).toEqual(expected.summary);
    expect(verdict.copyText).toBe(expected.copyText);
    expect(verdict.remaining).toBe(expected.remaining);
    expect(verdict.steps[0]).toMatchObject({ stageId: 7, relatedTypes: ['straggler'], recommendation: 'Fix skew in Stage 7.' });
    expect(verdict.steps[0].copyText).toBe('Fix task skew: Fix skew in Stage 7. Potential savings: 2.4s of run time');
  });

  it('carries the failure: its reason and the quoted-reason step text', () => {
    /** @type {Finding} */
    const stageFailed = {
      variant: 'stageFailure', numTasks: 0, memoryBytesSpilled: 0, failedTaskDetails: [],
      id: 'stageFailed-3', type: 'stageFailed', stageId: 3, impactBand: 'critical', valueText: 'Task failed: boom\n\tat x', recommendation: 'Inspect the driver log.' };
    const model = appModel({ jobs: new Map([[1, failedJob(1, [3])]]) });
    const interpretation = interpretRun(model, [timed('skew', 7, 2_400), stageFailed], []);

    expect(interpretation.verdict).toMatchObject({ failed: true, clean: false, failureReason: 'Task failed: boom' });
    expect(interpretation.verdict.steps[0].recommendation).toContain("Spark's recorded reason is quoted above.");
    expect(interpretation.verdict.steps[0].copyText).toContain("Spark's recorded reason: Task failed: boom.");
  });

  it('records which checks could not run, with the reasons checkCoverage gives', () => {
    const model = appModel({ stages: new Map([[1, makeTypedStage({ id: 1, completedAt: undefined })]]) });
    /** @type {Finding} */
    const incomplete = { id: 'incompleteRun', type: 'incompleteRun', valueText: 'missing', stageId: null, impactBand: 'warning', recommendation: 'r' };
    const { coverage } = interpretRun(model, [incomplete], []);
    const expected = checkCoverage(model.stages, [incomplete]);

    const notRunByType = Object.fromEntries(coverage.notRun.map((check) => [check.type, check.reason]));
    for (const type of FINDING_DISPLAY_ORDER) {
      if (type === 'coreLocality') continue;
      expect(notRunByType[type] ?? null).toBe(expected.notRunReason(type));
    }
    expect(notRunByType.skew).toMatch(/No stage in this log recorded an end/);
    expect(coverage.noFinishedStages).toBe(true);
    expect(coverage.gaps).toHaveLength(2);
  });

  it('lists the same clean and not-run checks as the CLI/MCP report, including an unreported write', () => {
    const write = { name: 'Execute InsertIntoHadoopFsRelationCommand', detail: '/out/t, false, Parquet', metrics: [], children: [] };
    const model = appModel({ sql: new Map([[4, { id: 4, planTree: write }]]) });
    const run = analyzeRun(model);
    const { interpretation } = run;
    const { cleanChecks, notRunChecks } = buildEvidenceReport(model, { markdown: false }).json;
    /** @param {{ type: string }[]} checks */
    const typesOf = (checks) => checks.map((check) => check.type);

    expect(typesOf(interpretation.coverage.clean)).toEqual(typesOf(cleanChecks));
    expect(typesOf(interpretation.coverage.notRun)).toEqual(typesOf(notRunChecks));
    expect(typesOf(notRunChecks)).toContain('writeOutputRows');
    expect(interpretation.coverage.notRun.find((check) => check.type === 'writeOutputRows'))
      .toMatchObject({ tag: 'INCMP', label: 'Write output rows' });
    // A type with a real finding is neither, and a reference widget is not a check.
    const fired = [...run.catalog, ...run.configFindings].filter((finding) => !isCaveat(finding)).map((finding) => finding.type);
    expect(fired.length).toBeGreaterThan(0);
    for (const type of [...fired, 'coreLocality']) {
      expect(typesOf([...cleanChecks, ...notRunChecks])).not.toContain(type);
    }
  });

  it('carries the run shape and the Scorecard flags', () => {
    const model = appModel({ app: makeApp({ startTime: 0, endTime: 100_000 }) });
    const { runShape } = interpretRun(model, [], []);

    const { wallClockMs, efficiencyPct, unusedCoreTimePct } = computeRunShape(model);
    expect(runShape).toMatchObject({ wallClockMs, efficiencyPct, unusedCoreTimePct });
    expect(runShape).toMatchObject({ efficiencyPct: 15, efficiencyFlag: 'critical' });
    expect(runShape.unusedCoreTimeUnavailableReason).toBe('core-usage-summary');
    expect(interpretRun(appModel({ app: makeApp({ endTime: undefined }) }), [], []).runShape)
      .toMatchObject({ wallClockMs: null });
  });

  it('orders a stage\'s finding types by its own verdict step, then worst band', () => {
    /** @type {Finding} */
    const info = { id: 'tinyTask-7', type: 'tinyTask', stageId: 7, impactBand: 'info', recommendation: 'r' };
    /** @type {Finding} */
    const critical = { id: 'gc-7', type: 'gc', stageId: 7, impactBand: 'critical', recommendation: 'r' };
    const quantified = timed('skew', 7, 2_400, 'warning');
    /** @type {Finding} */
    const unrankable = { id: 'spill-7', type: 'spill', stageId: 7, impactBand: 'critical' };
    const catalog = [info, critical, quantified, unrankable];
    const { stages } = interpretRun(appModel(), catalog, []);

    expect(stages['7'].findingIds).toEqual(catalog.map((finding) => finding.id));
    // skew leads (quantified), gc and tinyTask follow as its related types, then the unrankable spill.
    expect(stages['7'].typeOrder).toEqual(['skew', 'gc', 'tinyTask', 'spill']);
  });

  it('agrees with the evidence report the same core prints for the same run', () => {
    const model = appModel({
      stages: new Map([[1, makeTypedStage({ id: 1, taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 9_000, taskCount: 10 })]]),
    });
    const catalog = analyzedRunFrom(model).catalog;
    const interpretation = interpretRun(model, catalog, auditConfig(model.app));
    const { json } = buildEvidenceReport(model, { markdown: false });

    expect(interpretation.verdict.title).toBe(json.verdict.title);
    expect(interpretation.verdict.summary).toEqual(json.verdict.summary);
    expect(interpretation.verdict.copyText).toBe(json.verdict.copyText);
    expect(interpretation.verdict.clean).toBe(json.summary.clean);
    const { wallClockMs, efficiencyPct, unusedCoreTimePct, efficiencyFlag, unusedCoreTimeFlag } = json.summary.runShape;
    expect(interpretation.runShape).toMatchObject({ wallClockMs, efficiencyPct, unusedCoreTimePct, efficiencyFlag, unusedCoreTimeFlag });
    // The Findings board lists the report's "Fix these first" groups, members in the same order.
    const eligible = catalog.filter((f) => f.id !== undefined && interpretation.rollup.eligibleIds.includes(f.id));
    expect(rankedRollup(eligible, model.stages).map((group) => ({ type: group.type, ids: group.members.map((f) => f.id) })))
      .toEqual(json.recommendations.map((row) => ({ type: row.type, ids: row.findingIds })));
    expect(json.recommendations.length).toBeGreaterThan(0);
  });

  it('gives the Unused core time tile the verdict\'s idle share on a run that replaced an executor', () => {
    // Executor 1 leaves at 50s as its same-size replacement joins: 4 cores are ever concurrent
    // although 8 were added. One busy core for the whole run leaves 75% of the capacity idle;
    // summing every addition would have put the tile at 88% beside a 75% verdict.
    /** @type {import('../src/types.ts').ExecutorAddedEvent[]} */
    const added = [
      { kind: 'added', executorId: '1', timestamp: 0, host: 'host-1', totalCores: 4, resourceProfileId: null },
      { kind: 'added', executorId: '2', timestamp: 50_000, host: 'host-2', totalCores: 4, resourceProfileId: null },
    ];
    /** @type {import('../src/types.ts').ExecutorRemovedEvent[]} */
    const removed = [{ kind: 'removed', executorId: '1', timestamp: 50_000, reason: 'replaced' }];
    const model = appModel({
      app: makeApp({ startTime: 0, endTime: 100_000 }),
      stages: new Map([[1, makeTypedStage({ id: 1, submittedAt: 0, completedAt: 100_000 })]]),
      executors: { added, removed },
      runAggregates: { busyCoreMs: 100_000, perStage: { 1: { totalTaskDurationSum: 100_000, taskCount: 100 } } },
    });
    const catalog = analyzedRunFrom(model).catalog;
    const interpretation = interpretRun(model, catalog, []);

    const idleCores = catalog.find((f) => f.type === 'memoryUtilization' && f.variant === 'idleCores');
    expect(idleCores?.value).toBe(75);
    expect(interpretation.runShape.unusedCoreTimePct).toBe(75);
    expect(interpretation.efficiency?.wastagePct).toBe(75);
    expect(interpretation.wastedCoreHours.totalCores).toBe(4);
  });

  it('carries the Findings board: the eligible finding ids, which rankedRollup groups in fix-first order', () => {
    /** @type {Finding} */
    const incomplete = { id: 'incompleteRun', type: 'incompleteRun', valueText: 'missing', stageId: null, impactBand: 'warning', recommendation: 'r' };
    const bigInfo = timed('skew', 7, 5_000, 'info');
    const smallCritical = timed('skew', 3, 1_000, 'critical');
    const spill = timed('spill', 3, 800);
    const catalog = [incomplete, bigInfo, smallCritical, spill];
    const model = appModel();
    const { rollup } = interpretRun(model, catalog, []);

    expect(rollup.eligibleIds).toEqual([bigInfo.id, smallCritical.id, spill.id]);
    const groups = rankedRollup(catalog.filter((f) => f.id !== undefined && rollup.eligibleIds.includes(f.id)), model.stages);
    expect(groups.map((group) => group.type)).toEqual(['skew', 'spill']);
    // Members representative first; the group sits under its worst member's band.
    expect(groups[0]).toMatchObject({ kind: 'time', band: 'critical', stat: '×2 · 6.0s recoverable' });
    expect(groups[0].members.map((f) => f.id)).toEqual([bigInfo.id, smallCritical.id]);
  });
});
