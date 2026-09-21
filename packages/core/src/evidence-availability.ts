import type { AppModel, EvidenceAvailability, EvidenceAvailabilityEntry, EvidenceEventType, EvidenceInputs, EvidenceKey, EvidenceReasonCode, EvidenceState } from './types';

// Not annotated `: number` on purpose: `const X = 1` infers the literal type `1`, assignable to
// the EvidenceAvailability.schemaVersion:1 literal field; widening to `number` would break that.
export const EVIDENCE_AVAILABILITY_SCHEMA_VERSION = 1;

const SUMMARIES: Record<EvidenceReasonCode, string> = {
  observed: 'Observed in this event log.',
  explicitlyDisabled: 'Explicitly disabled in this event log.',
  noObservedExecutorMetrics: 'Not emitted by this event log.',
  noObservedStageSubmission: 'Not emitted by this event log.',
  noRddStorageSnapshot: 'Stages were submitted without RDD storage snapshots.',
  noResolvedSqlPlan: 'Not emitted by this event log.',
  noSqlExecution: 'Not applicable to this event log.',
  noEnvironmentUpdate: 'Not emitted by this event log.',
  noTaskRecords: 'Not emitted by this event log.',
  noUsableCoreTimeAggregate: 'No usable aggregate was emitted.',
  outsideEventLogScope: 'Available outside local event-log scope.',
  parseIncomplete: 'Cannot determine from an incomplete parse.',
};

function observed(key: EvidenceKey, eventType: EvidenceEventType, count: number): EvidenceAvailabilityEntry {
  return { key, state: 'present', reasonCode: 'observed', summary: SUMMARIES.observed, evidence: { eventType, count } };
}

function entry(key: EvidenceKey, state: EvidenceState, reasonCode: EvidenceReasonCode): EvidenceAvailabilityEntry {
  return { key, state, reasonCode, summary: SUMMARIES[reasonCode] };
}

function count(inputs: Partial<EvidenceInputs>, key: keyof EvidenceInputs): number {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** True when the serialized value is a ledger this build understands. Fails
 * closed on any unknown `schemaVersion` so a future, incompatible ledger is
 * never trusted as V1 data; used at read/restore time, not just write time. */
export function isSupportedEvidenceAvailability(value: unknown): boolean {
  return value != null && (value as { schemaVersion?: unknown }).schemaVersion === EVIDENCE_AVAILABILITY_SCHEMA_VERSION;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** A stage contributes usable core-time evidence only when it both ran tasks and produced a
 * positive duration sum: a degenerate aggregate (every task finish <= launch) proves nothing.
 * Shared with ScalingSim so the two consumers can't drift. */
export function hasUsableRunAggregates(runAggregates: unknown): boolean {
  const perStage = (runAggregates as { perStage?: unknown } | null | undefined)?.perStage;
  return perStage != null
    && typeof perStage === 'object'
    && !Array.isArray(perStage)
    && Object.values(perStage as Record<string, { taskCount?: unknown; totalTaskDurationSum?: unknown }>).some(
      (stage) => isPositiveFinite(stage?.taskCount) && isPositiveFinite(stage?.totalTaskDurationSum),
    );
}

/** Matches the parser's config normalization (`.toLowerCase() === 'true'`),
 * so a real boolean or mixed-case `'False'` is handled identically. */
function configIs(value: unknown, expected: string): boolean {
  return value != null && String(value).toLowerCase() === expected;
}

function absent(key: EvidenceKey, reasonCode: EvidenceReasonCode, trustworthy: boolean): EvidenceAvailabilityEntry {
  return trustworthy ? entry(key, reasonCode === 'noSqlExecution' ? 'notApplicable' : 'notEmitted', reasonCode) : entry(key, 'unknown', 'parseIncomplete');
}

export function deriveEvidenceAvailability(appModel: AppModel, { skippedLines = 0 }: { skippedLines?: number } = {}): EvidenceAvailability {
  const app = appModel?.app;
  const inputs: Partial<EvidenceInputs> = app?.evidenceInputs ?? {};
  const trustworthy = skippedLines === 0 && count(inputs, 'applicationEnds') > 0;
  const metricRows = count(inputs, 'executorMetricRows');
  const submissions = count(inputs, 'stageSubmissions');
  const snapshots = count(inputs, 'rddStorageSnapshots');
  const plans = count(inputs, 'resolvedSqlPlans');
  const executions = count(inputs, 'sqlExecutions');
  const environments = count(inputs, 'environmentUpdates');
  const taskRecords = count(inputs, 'taskRecords');

  const executorMetrics = metricRows > 0
    ? observed('executorMetrics', 'executorMetricRows', metricRows)
    : configIs(app?.config?.['spark.eventLog.logStageExecutorMetrics'], 'false')
      ? entry('executorMetrics', 'disabled', 'explicitlyDisabled')
      : absent('executorMetrics', 'noObservedExecutorMetrics', trustworthy);
  const rddStorageSnapshots = snapshots > 0
    ? observed('rddStorageSnapshots', 'rddStorageSnapshots', snapshots)
    : absent('rddStorageSnapshots', submissions === 0 ? 'noObservedStageSubmission' : 'noRddStorageSnapshot', trustworthy);
  const sqlPlan = plans > 0
    ? observed('sqlPlan', 'resolvedSqlPlans', plans)
    : executions > 0 && trustworthy
      ? entry('sqlPlan', 'notEmitted', 'noResolvedSqlPlan')
      : absent('sqlPlan', 'noSqlExecution', trustworthy);
  const sparkConfiguration = environments > 0
    ? observed('sparkConfiguration', 'environmentUpdates', environments)
    : absent('sparkConfiguration', 'noEnvironmentUpdate', trustworthy);
  const taskCoreTime = taskRecords === 0
    ? absent('taskCoreTime', 'noTaskRecords', trustworthy)
    : hasUsableRunAggregates(appModel?.runAggregates)
      ? observed('taskCoreTime', 'taskRecords', taskRecords)
      : absent('taskCoreTime', 'noUsableCoreTimeAggregate', trustworthy);

  return {
    schemaVersion: EVIDENCE_AVAILABILITY_SCHEMA_VERSION,
    entries: [
      executorMetrics,
      rddStorageSnapshots,
      sqlPlan,
      sparkConfiguration,
      taskCoreTime,
      entry('infrastructureContext', 'outsideEventLog', 'outsideEventLogScope'),
      entry('sourceContext', 'outsideEventLog', 'outsideEventLogScope'),
      entry('costContext', 'outsideEventLog', 'outsideEventLogScope'),
    ],
  };
}
