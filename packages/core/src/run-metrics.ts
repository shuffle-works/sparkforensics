// The machine-readable metrics block of the CLI's JSON output: run-level totals and per-stage rows
// an automated tuning loop can compare across runs without reading a report. Its schemaVersion
// moves independently of the evidence report's. A figure the log cannot provide is null, never 0.
import { computeAllocation, type Allocation } from './allocation.ts';
import { computeSkewRatio, ENTRY_BY_TYPE, type ThresholdOverrides } from './detectors.ts';
import { nsToMs } from './format-utils.ts';
import { isPythonStage } from './python-stage.ts';
import { stageIdentity } from './run-comparison.ts';
import { hasCompleteApplicationInterval } from './scorecard-estimates.ts';
import { effectiveThresholds } from './threshold-overrides.ts';
import { computeWallClock } from './wall-clock.ts';
import type { AppModel, Stage } from './types.ts';

export const METRICS_SCHEMA_VERSION = 1;

export interface StageMetrics {
  durationMs: number | null;
  executorCpuTimeMs: number | null;
  executorRunTimeMs: number | null;
  gcTimeMs: number | null;
  memorySpillBytes: number | null;
  diskSpillBytes: number | null;
  shuffleReadBytes: number | null;
  shuffleWriteBytes: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
  outputRows: number | null;
  peakExecutionMemoryBytes: number | null;
  taskCount: number | null;
  failedTasks: number | null;
  retriedTasks: number | null;
  skew: number | null;
}

export interface StageMetricsRow extends StageMetrics {
  /** Every stage id that folded into this fingerprint (a stage repeated in a loop shares one). */
  stageIds: number[];
  /** A stage attempt failed / the stage was submitted more than once; null when a stage record
   * carries no attempt count. */
  failed: boolean | null;
  retried: boolean | null;
  python: boolean;
}

export interface RunMetrics {
  schemaVersion: number;
  /** True when the log has an ApplicationEnd. False means it was cut off: every total covers only
   * what the log recorded, and executors with no removal event close at the last timestamp. */
  runComplete: boolean;
  time: { wallClockMs: number | null; executorCpuTimeMs: number | null; executorRunTimeMs: number | null; gcTimeMs: number | null };
  data: {
    memorySpillBytes: number | null; diskSpillBytes: number | null;
    shuffleReadBytes: number | null; shuffleWriteBytes: number | null;
    inputBytes: number | null; outputBytes: number | null; outputRows: number | null;
    peakExecutionMemoryBytes: number | null;
  };
  shape: {
    taskCount: number | null; stageCount: number;
    /** Stage attempts that failed, and stages submitted more than once (null when a stage record
     * carries no attempt count). Task-level retries are failedTasks / retriedTasks. */
    failedStageAttempts: number | null; retriedStages: number | null;
    failedTasks: number | null; retriedTasks: number | null; maxSkew: number | null;
  };
  allocation: Allocation;
  python: {
    /** Task run time of Python stages over all task run time; null without task run time. */
    shareOfTaskRunTime: number | null;
  };
  stages: Record<string, StageMetricsRow>;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

// Σ of a field over the stages that carry a finite value; null when none does.
function sumOf(stages: Stage[], pick: (s: Stage) => number | null | undefined): number | null {
  let sum = 0, present = false;
  for (const s of stages) {
    const v = pick(s);
    if (finite(v)) { sum += v; present = true; }
  }
  return present ? sum : null;
}

// Spark records CPU time in nanoseconds and the parser defaults an absent metric to 0, so a run
// whose stages all read 0 never recorded it (older Spark): null, not a zero-second run.
function cpuTimeMs(stages: Stage[]): number | null {
  const ns = sumOf(stages, (s) => (finite(s.executorCpuTime) && s.executorCpuTime > 0 ? s.executorCpuTime : null));
  return ns == null ? null : nsToMs(ns);
}

// 0 means either no execution memory used or not recorded; only a positive peak is reported.
function peakExecutionMemory(stages: Stage[]): number | null {
  const peaks = stages.map((s) => s.peakExecutionMemoryMax).filter((v): v is number => finite(v) && v > 0);
  return peaks.length > 0 ? Math.max(...peaks) : null;
}

function maxSkew(stages: Stage[], minTasksForP95: number): number | null {
  const ratios = stages
    .map((s) => computeSkewRatio(s, minTasksForP95)?.ratio)
    .filter((r): r is number => finite(r));
  return ratios.length > 0 ? Math.max(...ratios) : null;
}

// Failed stage attempts and stages submitted more than once, from the parser's per-stage attempt
// counts; null when any stage record lacks them.
function stageAttempts(stages: Stage[]): { failed: number; retried: number } | null {
  let failed = 0, retried = 0;
  for (const s of stages) {
    if (!finite(s.stageAttempts) || !finite(s.failedStageAttempts)) return null;
    failed += s.failedStageAttempts;
    if (s.stageAttempts > 1) retried++;
  }
  return { failed, retried };
}

// Each stage followed by the work its own figures leave out, shaped like a stage, so every total
// sums the attempts a resubmit replaced and the tasks of a failed attempt that ended after it.
function withEarlierAttempts(stages: Stage[]): Stage[] {
  return stages.flatMap((s) => [s, ...[s.earlierAttempts, s.lateAttemptWork]
    .filter((work) => work != null)
    .map(({ durationMs, ...totals }) => ({ id: s.id, ...totals, submittedAt: 0, completedAt: durationMs ?? undefined }))]);
}

// Metrics of a set of stages, every attempt included; a row folds the stages sharing one
// fingerprint. Skew describes the latest attempt's task durations.
function stageMetrics(stages: Stage[], minTasksForP95: number): StageMetrics {
  const attempts = withEarlierAttempts(stages);
  // Task-derived figures are null for stages that never finished (no task records).
  // Superseded attempts carry work but no task count of their own, so they stay in once any
  // attempt finished a task.
  const finished = attempts.some((s) => (s.taskCount ?? 0) > 0) ? attempts : [];
  const tasks = sumOf(attempts, (s) => s.taskCount);
  const fromTasks = (pick: (s: Stage) => number | undefined): number | null => (finished.length > 0 ? sumOf(finished, pick) : null);
  const durations = attempts.filter((s) => finite(s.submittedAt) && finite(s.completedAt) && (s.completedAt as number) >= (s.submittedAt as number));
  return {
    durationMs: durations.length > 0 ? sumOf(durations, (s) => (s.completedAt as number) - (s.submittedAt as number)) : null,
    executorCpuTimeMs: cpuTimeMs(finished),
    executorRunTimeMs: fromTasks((s) => s.executorRunTime),
    gcTimeMs: fromTasks((s) => s.jvmGCTime),
    memorySpillBytes: fromTasks((s) => s.memoryBytesSpilled),
    diskSpillBytes: fromTasks((s) => s.diskBytesSpilled),
    shuffleReadBytes: fromTasks((s) => s.shuffleReadBytes),
    shuffleWriteBytes: fromTasks((s) => s.shuffleWriteBytes),
    inputBytes: fromTasks((s) => s.inputBytes),
    outputBytes: fromTasks((s) => s.outputBytes),
    outputRows: sumOf(finished, (s) => s.outputRecords),
    peakExecutionMemoryBytes: peakExecutionMemory(finished),
    taskCount: tasks != null && tasks > 0 ? tasks : null,
    failedTasks: fromTasks((s) => s.failedTasks),
    retriedTasks: fromTasks((s) => (s.wastedAttempts as number | undefined) ?? 0),
    skew: maxSkew(stages.filter((s) => (s.taskCount ?? 0) > 0), minTasksForP95),
  };
}

/** The run's metrics block. `thresholds` only moves the skew ratio's P95 cutoff, as for the
 * --max-skew budget. */
export function computeRunMetrics(appModel: AppModel, thresholds?: ThresholdOverrides): RunMetrics {
  const stageList = [...appModel.stages.values()];
  const minTasksForP95 = effectiveThresholds(ENTRY_BY_TYPE.get('skew')!, thresholds).minTasksForP95 as number;
  const python = stageList.filter((s) => isPythonStage(s, appModel.sql));
  const runTimeMs = stageMetrics(stageList, minTasksForP95).executorRunTimeMs;
  const pythonRunTimeMs = sumOf(withEarlierAttempts(python), (s) => s.executorRunTime);

  const byFingerprint = new Map<string, Stage[]>();
  for (const s of stageList) {
    const key = stageIdentity(s, appModel);
    const group = byFingerprint.get(key);
    if (group) group.push(s); else byFingerprint.set(key, [s]);
  }
  const stages: Record<string, StageMetricsRow> = {};
  for (const [key, group] of byFingerprint) {
    const attempts = stageAttempts(group);
    stages[key] = {
      stageIds: group.map((s) => s.id).sort((a, b) => a - b),
      failed: attempts ? attempts.failed > 0 : null,
      retried: attempts ? attempts.retried > 0 : null,
      python: group.some((s) => isPythonStage(s, appModel.sql)),
      ...stageMetrics(group, minTasksForP95),
    };
  }

  const all = stageMetrics(stageList, minTasksForP95);
  const attempts = stageAttempts(stageList);
  return {
    schemaVersion: METRICS_SCHEMA_VERSION,
    runComplete: appModel.app?.endTime != null,
    time: {
      wallClockMs: hasCompleteApplicationInterval(appModel.app) ? computeWallClock(appModel.app, appModel.stages).total : null,
      executorCpuTimeMs: all.executorCpuTimeMs,
      executorRunTimeMs: all.executorRunTimeMs,
      gcTimeMs: all.gcTimeMs,
    },
    data: {
      memorySpillBytes: all.memorySpillBytes, diskSpillBytes: all.diskSpillBytes,
      shuffleReadBytes: all.shuffleReadBytes, shuffleWriteBytes: all.shuffleWriteBytes,
      inputBytes: all.inputBytes, outputBytes: all.outputBytes, outputRows: all.outputRows,
      peakExecutionMemoryBytes: all.peakExecutionMemoryBytes,
    },
    shape: {
      taskCount: all.taskCount,
      stageCount: stageList.length,
      failedStageAttempts: attempts?.failed ?? null,
      retriedStages: attempts?.retried ?? null,
      failedTasks: all.failedTasks,
      retriedTasks: all.retriedTasks,
      maxSkew: all.skew,
    },
    allocation: computeAllocation(appModel),
    python: {
      shareOfTaskRunTime: runTimeMs != null && runTimeMs > 0 ? (pythonRunTimeMs ?? 0) / runTimeMs : null,
    },
    stages,
  };
}
