import { describe, expect, it } from 'vitest';
import {
  deriveEvidenceAvailability,
  EVIDENCE_AVAILABILITY_SCHEMA_VERSION,
} from '../src/evidence-availability.js';

// Closed enums the serialized ledger must stay within; kept here since nothing but these tests consumes them.
const EVIDENCE_KEYS = [
  'executorMetrics',
  'rddStorageSnapshots',
  'sqlPlan',
  'sparkConfiguration',
  'taskCoreTime',
  'infrastructureContext',
  'sourceContext',
  'costContext',
];

const EVIDENCE_STATES = [
  'present',
  'disabled',
  'notEmitted',
  'notApplicable',
  'outsideEventLog',
  'unknown',
];

const EVIDENCE_REASON_CODES = [
  'observed',
  'explicitlyDisabled',
  'noObservedExecutorMetrics',
  'noObservedStageSubmission',
  'noRddStorageSnapshot',
  'noResolvedSqlPlan',
  'noSqlExecution',
  'noEnvironmentUpdate',
  'noTaskRecords',
  'noUsableCoreTimeAggregate',
  'outsideEventLogScope',
  'parseIncomplete',
];

const complete = { skippedLines: 0 };
const evidenceInputs = {
  environmentUpdates: 1,
  applicationEnds: 1,
  stageSubmissions: 0,
  rddStorageSnapshots: 0,
  sqlExecutions: 0,
  resolvedSqlPlans: 0,
  executorMetricRows: 0,
  taskRecords: 0,
};

function model(overrides = {}) {
  const { app: appOverrides, ...rest } = overrides;
  return { app: { evidenceInputs, ...appOverrides }, stages: new Map(), sql: new Map(), runAggregates: null, ...rest };
}

function entry(ledger, key) {
  return ledger.entries.find((candidate) => candidate.key === key);
}

describe('deriveEvidenceAvailability', () => {
  it('uses the stable ordered, versioned availability schema', () => {
    const ledger = deriveEvidenceAvailability(model(), complete);
    expect(ledger.schemaVersion).toBe(1);
    expect(EVIDENCE_AVAILABILITY_SCHEMA_VERSION).toBe(1);
    expect(ledger.entries.map(({ key }) => key)).toEqual([
      'executorMetrics', 'rddStorageSnapshots', 'sqlPlan', 'sparkConfiguration',
      'taskCoreTime', 'infrastructureContext', 'sourceContext', 'costContext',
    ]);
    expect(EVIDENCE_KEYS).toEqual(ledger.entries.map(({ key }) => key));
    expect(EVIDENCE_REASON_CODES).toEqual([
      'observed', 'explicitlyDisabled', 'noObservedExecutorMetrics',
      'noObservedStageSubmission', 'noRddStorageSnapshot', 'noResolvedSqlPlan',
      'noSqlExecution', 'noEnvironmentUpdate', 'noTaskRecords',
      'noUsableCoreTimeAggregate', 'outsideEventLogScope', 'parseIncomplete',
    ]);
  });

  it('reports observed executor metrics before an explicit disablement', () => {
    const ledger = deriveEvidenceAvailability(model({ app: {
      evidenceInputs: { ...evidenceInputs, executorMetricRows: 2 },
      config: { 'spark.eventLog.logStageExecutorMetrics': 'false' },
    } }), complete);
    expect(entry(ledger, 'executorMetrics')).toMatchObject({
      state: 'present', reasonCode: 'observed', evidence: { eventType: 'executorMetricRows', count: 2 },
    });
  });

  it('distinguishes an explicit metric disablement from an omitted setting', () => {
    const disabled = deriveEvidenceAvailability(model({ app: { config: { 'spark.eventLog.logStageExecutorMetrics': 'false' } } }), complete);
    const omitted = deriveEvidenceAvailability(model(), complete);
    expect(entry(disabled, 'executorMetrics')).toMatchObject({ state: 'disabled', reasonCode: 'explicitlyDisabled' });
    expect(entry(omitted, 'executorMetrics')).toMatchObject({ state: 'notEmitted', reasonCode: 'noObservedExecutorMetrics' });
  });

  it.each([
    ['mixed-case False string', 'False'],
    ['real boolean false', false],
  ])('treats %s as an explicit metric disablement', (_label, value) => {
    const ledger = deriveEvidenceAvailability(model({ app: { config: { 'spark.eventLog.logStageExecutorMetrics': value } } }), complete);
    expect(entry(ledger, 'executorMetrics')).toMatchObject({ state: 'disabled', reasonCode: 'explicitlyDisabled' });
  });

  it('derives each observed event-log category from its safe counter', () => {
    const ledger = deriveEvidenceAvailability(model({
      app: { evidenceInputs: { ...evidenceInputs, rddStorageSnapshots: 3, sqlExecutions: 2, resolvedSqlPlans: 1, taskRecords: 4 } },
      runAggregates: { busyCoreMs: 120, perStage: { 7: { taskCount: 4, totalTaskDurationSum: 2000 } } },
    }), complete);
    expect(entry(ledger, 'rddStorageSnapshots')).toMatchObject({ state: 'present', reasonCode: 'observed', evidence: { eventType: 'rddStorageSnapshots', count: 3 } });
    expect(entry(ledger, 'sqlPlan')).toMatchObject({ state: 'present', reasonCode: 'observed', evidence: { eventType: 'resolvedSqlPlans', count: 1 } });
    expect(entry(ledger, 'sparkConfiguration')).toMatchObject({ state: 'present', reasonCode: 'observed', evidence: { eventType: 'environmentUpdates', count: 1 } });
    expect(entry(ledger, 'taskCoreTime')).toMatchObject({ state: 'present', reasonCode: 'observed', evidence: { eventType: 'taskRecords', count: 4 } });
  });

  it('uses no-observation reasons for trustworthy absent categories', () => {
    const ledger = deriveEvidenceAvailability(model({ app: { evidenceInputs: { ...evidenceInputs, environmentUpdates: 0 } } }), complete);
    expect(entry(ledger, 'rddStorageSnapshots')).toMatchObject({ state: 'notEmitted', reasonCode: 'noObservedStageSubmission' });
    expect(entry(ledger, 'sqlPlan')).toMatchObject({ state: 'notApplicable', reasonCode: 'noSqlExecution' });
    expect(entry(ledger, 'sparkConfiguration')).toMatchObject({ state: 'notEmitted', reasonCode: 'noEnvironmentUpdate' });
    expect(entry(ledger, 'taskCoreTime')).toMatchObject({ state: 'notEmitted', reasonCode: 'noTaskRecords' });
  });

  it('distinguishes no submitted stages from stages submitted without RDD storage snapshots', () => {
    const noSubmissions = deriveEvidenceAvailability(model(), complete);
    const noSnapshots = deriveEvidenceAvailability(
      model({ app: { evidenceInputs: { ...evidenceInputs, stageSubmissions: 1 } } }),
      complete,
    );
    expect(entry(noSubmissions, 'rddStorageSnapshots')).toMatchObject({ state: 'notEmitted', reasonCode: 'noObservedStageSubmission' });
    expect(entry(noSnapshots, 'rddStorageSnapshots')).toMatchObject({ state: 'notEmitted', reasonCode: 'noRddStorageSnapshot' });
  });

  it('reports an SQL execution without a resolved plan as not emitted', () => {
    const ledger = deriveEvidenceAvailability(model({ app: { evidenceInputs: { ...evidenceInputs, sqlExecutions: 1 } } }), complete);
    expect(entry(ledger, 'sqlPlan')).toMatchObject({ state: 'notEmitted', reasonCode: 'noResolvedSqlPlan' });
  });

  it('distinguishes task records with no usable aggregate from no task records', () => {
    const ledger = deriveEvidenceAvailability(model({
      app: { evidenceInputs: { ...evidenceInputs, taskRecords: 2 } }, runAggregates: {},
    }), complete);
    expect(entry(ledger, 'taskCoreTime')).toMatchObject({
      state: 'notEmitted', reasonCode: 'noUsableCoreTimeAggregate',
    });
  });

  it.each([['skipped lines', { skippedLines: 1 }], ['missing application end', complete]])(
    'fails closed for absence-based claims after %s', (_label, metadata) => {
      const incompleteInputs = { ...evidenceInputs, environmentUpdates: 0 };
      const app = metadata === complete
        ? { evidenceInputs: { ...incompleteInputs, applicationEnds: 0 } }
        : { evidenceInputs: incompleteInputs };
      const ledger = deriveEvidenceAvailability(model({ app }), metadata);
      for (const key of ['executorMetrics', 'rddStorageSnapshots', 'sqlPlan', 'sparkConfiguration', 'taskCoreTime']) {
        expect(entry(ledger, key)).toMatchObject({ state: 'unknown', reasonCode: 'parseIncomplete' });
      }
    },
  );

  it('retains observed evidence when parsing is incomplete', () => {
    const ledger = deriveEvidenceAvailability(model({ app: {
      evidenceInputs: { ...evidenceInputs, applicationEnds: 0, executorMetricRows: 2, rddStorageSnapshots: 1 },
      config: { 'spark.eventLog.logStageExecutorMetrics': 'false' },
    } }), { skippedLines: 1 });
    expect(entry(ledger, 'executorMetrics')).toMatchObject({ state: 'present', reasonCode: 'observed' });
    expect(entry(ledger, 'rddStorageSnapshots')).toMatchObject({ state: 'present', reasonCode: 'observed' });
    expect(entry(ledger, 'sqlPlan')).toMatchObject({ state: 'unknown', reasonCode: 'parseIncomplete' });
  });

  it('retains a proven explicit disablement when parsing is incomplete', () => {
    const ledger = deriveEvidenceAvailability(model({ app: {
      evidenceInputs: { ...evidenceInputs, applicationEnds: 0 },
      config: { 'spark.eventLog.logStageExecutorMetrics': 'false' },
    } }), { skippedLines: 1 });

    expect(entry(ledger, 'executorMetrics')).toMatchObject({ state: 'disabled', reasonCode: 'explicitlyDisabled' });
  });

  it('keeps infrastructure, source, and cost context outside event-log scope', () => {
    const ledger = deriveEvidenceAvailability(model(), { skippedLines: 9 });
    for (const key of ['infrastructureContext', 'sourceContext', 'costContext']) {
      expect(entry(ledger, key)).toMatchObject({ state: 'outsideEventLog', reasonCode: 'outsideEventLogScope' });
    }
  });

  it('serializes only closed enums and compact, non-sensitive provenance', () => {
    const ledger = deriveEvidenceAvailability(model({
      app: {
        evidenceInputs: { ...evidenceInputs, executorMetricRows: 1, taskRecords: 1 },
        config: { 'spark.eventLog.logStageExecutorMetrics': 'false', 'spark.executor.memory': 'spark.executor.memory=24g' },
        host: 'worker-host',
      },
      sql: new Map([[1, { text: 'SELECT * FROM sensitive_path/' }]]),
      runAggregates: { busyCoreMs: 1, perStage: { 1: { taskCount: 1, records: [{ id: 1 }] } } },
    }), complete);
    const serialized = JSON.stringify(ledger);
    for (const unsafeText of ['spark.executor.memory=', 'host', '/', 'SELECT', 'records']) expect(serialized).not.toContain(unsafeText);
    for (const candidate of ledger.entries) {
      expect(EVIDENCE_KEYS).toContain(candidate.key);
      expect(EVIDENCE_STATES).toContain(candidate.state);
      expect(EVIDENCE_REASON_CODES).toContain(candidate.reasonCode);
      expect(candidate.summary).toEqual(expect.any(String));
      if (candidate.evidence) expect(Object.keys(candidate.evidence).sort()).toEqual(['count', 'eventType']);
    }
  });
});
