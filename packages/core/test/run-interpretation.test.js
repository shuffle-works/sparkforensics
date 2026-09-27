import { describe, it, expect } from 'vitest';
import { analyze, auditConfig } from '../src/analyzer.ts';
import { checkCoverage, isCleanRun } from '../src/check-coverage.ts';
import { buildEvidenceReport } from '../src/evidence-report.ts';
import { impactEstimateCompact, impactEstimateFigure, impactFigure } from '../src/impact-format.ts';
import { interpretRun } from '../src/run-interpretation.ts';
import { computeRunShape } from '../src/run-shape.ts';
import { buildRunVerdict, FINDING_DISPLAY_ORDER } from '../src/run-verdict.ts';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

function timed(type, stageId, highMs, impactBand = 'warning') {
  return {
    type, stageId, impactBand, recommendation: `Fix ${type} in Stage ${stageId}.`,
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'modeled' },
  };
}

function appModel(overrides = {}) {
  return {
    app: makeApp({ startTime: 0, endTime: 20_000 }),
    stages: new Map([[7, makeStage({ id: 7, submittedAt: 0, completedAt: 15_000 })], [3, makeStage({ id: 3 })]]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
    ...overrides,
  };
}

const failedJob = (id, stageIds) => ({
  id, submissionTime: 0, stageIds, sqlExecutionId: null, result: 'JobFailed', succeeded: false, exception: null, completionTime: 1,
});

describe('interpretRun', () => {
  it('indexes findings in catalog-then-config order, with savings parallel to them', () => {
    const catalog = [timed('spill', 3, 1_000), timed('skew', 7, 2_400)];
    const config = [{ type: 'configAudit', property: 'spark.serializer', stageId: null, impactBand: 'info', recommendation: 'Use Kryo.' }];
    const interpretation = interpretRun(appModel(), catalog, config);
    const all = [...catalog, ...config];

    expect(interpretation.savings).toHaveLength(3);
    expect(interpretation.savings[1]).toEqual({
      figure: impactFigure(catalog[1]),
      meaning: 'of run time',
      board: impactEstimateFigure(catalog[1].impactEstimate).text,
      compact: impactEstimateCompact(catalog[1].impactEstimate),
      provenance: expect.stringContaining('2.4s'),
    });
    expect(interpretation.savings[2].figure).toBeNull();
    expect(interpretation.verdict.steps.map((step) => all[step.leadIndex])).toEqual([catalog[1], catalog[0], config[0]]);
    expect(interpretation.savingsRank.map((index) => all[index])).toEqual([catalog[1], catalog[0], config[0]]);
  });

  it('words the verdict exactly as buildRunVerdict does', () => {
    const model = appModel();
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

  it('carries the failure: its reason, the quoted-reason step text, and the failed jobs\' stages', () => {
    const stageFailed = { type: 'stageFailed', stageId: 3, impactBand: 'critical', value: 'Task failed: boom\n\tat x', recommendation: 'Inspect the driver log.' };
    const model = appModel({ jobs: new Map([[1, failedJob(1, [3])]]) });
    const interpretation = interpretRun(model, [timed('skew', 7, 2_400), stageFailed], []);

    expect(interpretation.verdict).toMatchObject({ failed: true, clean: false, failureReason: 'Task failed: boom' });
    expect(interpretation.verdict.steps[0].recommendation).toContain("Spark's recorded reason is quoted above.");
    expect(interpretation.verdict.steps[0].copyText).toContain("Spark's recorded reason: Task failed: boom.");
    expect(interpretation.failedJobStageIds).toEqual([3]);
    expect(interpretation.coverage.failedJobs).toBe(1);
  });

  it('records which checks could not run, with the reasons checkCoverage gives', () => {
    const model = appModel({ stages: new Map([[1, makeStage({ id: 1, completedAt: undefined })]]) });
    const incomplete = { type: 'incompleteRun', stageId: null, impactBand: 'warning', recommendation: 'r' };
    const { coverage } = interpretRun(model, [incomplete], []);
    const expected = checkCoverage(model.stages, [incomplete]);

    for (const type of FINDING_DISPLAY_ORDER) {
      expect(coverage.notRunReasons[type] ?? null).toBe(expected.notRunReason(type));
    }
    expect(coverage.notRunReasons.skew).toMatch(/No stage in this log recorded an end/);
    expect(coverage.noFinishedStages).toBe(true);
    expect(coverage.gaps).toHaveLength(2);
    expect(coverage.clean).toBe(isCleanRun(model, [incomplete]));
  });

  it('carries the run shape and the Scorecard flags', () => {
    const model = appModel({ app: makeApp({ startTime: 0, endTime: 100_000 }) });
    const { runShape } = interpretRun(model, [], []);

    expect(runShape).toMatchObject(computeRunShape(model));
    expect(runShape).toMatchObject({ timed: true, stagesActiveMs: 15_000, efficiencyPct: 15, efficiencyFlag: 'critical' });
    expect(runShape.unusedCoreTimeUnavailableReason).toBe('core-usage-summary');
    expect(interpretRun(appModel({ app: makeApp({ endTime: undefined }) }), [], []).runShape)
      .toMatchObject({ timed: false, wallClockMs: null, stagesActiveMs: null });
  });

  it('orders a stage\'s finding types by its own verdict step, then worst band', () => {
    const info = { type: 'tinyTask', stageId: 7, impactBand: 'info', recommendation: 'r' };
    const critical = { type: 'gc', stageId: 7, impactBand: 'critical', recommendation: 'r' };
    const quantified = timed('skew', 7, 2_400, 'warning');
    const unrankable = { type: 'spill', stageId: 7, impactBand: 'critical' };
    const catalog = [info, critical, quantified, unrankable];
    const { stages } = interpretRun(appModel(), catalog, []);

    expect(stages['7'].findingIndexes).toEqual([0, 1, 2, 3]);
    // skew leads (quantified), gc and tinyTask follow as its related types, then the unrankable spill.
    expect(stages['7'].typeOrder).toEqual(['skew', 'gc', 'tinyTask', 'spill']);
  });

  it('agrees with the evidence report the same core prints for the same run', () => {
    const model = appModel({
      stages: new Map([[1, makeStage({ id: 1, taskDurationP50: 100, taskDurationP95: 100, taskDurationMax: 9_000, taskCount: 10 })]]),
    });
    const catalog = analyze(model.app, model.stages, [], [], model.jobs, model.sql, null);
    const interpretation = interpretRun(model, catalog, auditConfig(model.app));
    const { json } = buildEvidenceReport(model, { markdown: false });

    expect(interpretation.verdict.title).toBe(json.verdict.title);
    expect(interpretation.verdict.summary).toEqual(json.verdict.summary);
    expect(interpretation.verdict.copyText).toBe(json.verdict.copyText);
    expect(interpretation.coverage.clean).toBe(json.summary.clean);
    expect(interpretation.runShape).toMatchObject(json.summary.runShape);
    // The Findings board lists the report's "Fix these first" groups, members in the same order.
    const all = [...catalog, ...auditConfig(model.app)];
    expect(interpretation.rollup.groups.map((group) => ({ type: group.type, ids: group.memberIndexes.map((i) => all[i].id) })))
      .toEqual(json.recommendations.map((row) => ({ type: row.type, ids: row.findingIds })));
    expect(interpretation.rollup.groups.length).toBeGreaterThan(0);
  });

  it('carries the Findings board: eligible findings, groups in fix-first order, bands and figures', () => {
    const incomplete = { type: 'incompleteRun', stageId: null, impactBand: 'warning', recommendation: 'r' };
    const bigInfo = timed('skew', 7, 5_000, 'info');
    const smallCritical = timed('skew', 3, 1_000, 'critical');
    const spill = timed('spill', 3, 800);
    const catalog = [incomplete, bigInfo, smallCritical, spill];
    const { rollup } = interpretRun(appModel(), catalog, []);

    expect(rollup.eligibleIndexes).toEqual([1, 2, 3]);
    expect(rollup.groups.map((group) => group.type)).toEqual(['skew', 'spill']);
    // Members representative first; the group sits under its representative's band, not its worst.
    expect(rollup.groups[0]).toMatchObject({ kind: 'time', band: 'info', memberIndexes: [1, 2], stat: '×2 · 6.0s recoverable' });
  });
});
