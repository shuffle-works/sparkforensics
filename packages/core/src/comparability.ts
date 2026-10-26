// The facts that decide whether two runs can be read against each other: what configuration and
// plan they share, how much data they handled, the capacity each had, and how those figures
// bridge the wall-clock difference. Built once per comparison, so every surface reports the same.
import { allocatedCoreMs, computeAllocation, lastObservedTimestamp } from './allocation.ts';
import { buildEffectiveConf } from './effective-conf.ts';
import { MAX_NORMALIZE_PATTERN_LENGTH, MAX_NORMALIZE_PATTERNS } from './stage-alignment.ts';
import { totalOutputRows, withEarlierAttempts } from './run-totals.ts';
import type { SessionSnapshot } from './session-snapshot.ts';
import type { StageAlignment } from './stage-alignment.ts';
import type { Stage } from './types.ts';

/** A configuration key whose value differs between the runs. A side that does not set the key is
 * null. */
export interface ConfDifference { key: string; baseline: string | null; candidate: string | null }

export interface ConfComparability {
  /** Null when a run's log records no Spark properties, so equality cannot be judged. Otherwise
   * `differences.length === 0`. */
  equal: boolean | null;
  /** Keys whose values differ, after the run-identity keys and the caller's ignore patterns are
   * left out. Values come from the effective-conf builder, so a secret is never in them. */
  differences: ConfDifference[];
  /** Keys that differ but are left out: run-identity keys and keys the caller's patterns match. */
  ignoredKeys: string[];
  /** Keys a run withholds as secrets. Their values are not compared. */
  withheldKeys: string[];
}

export interface PlanComparability {
  /** True when every stage pairs and none is re-planned. */
  equal: boolean;
  unmatched: { baseline: number; candidate: number };
  /** Groups of stages that exist in both runs under different plans. */
  replanned: number;
}

/** One data figure of both runs. `relativeDifference` is (candidate - baseline) / baseline, null
 * when either side is unmeasured or the baseline is 0 and the candidate is not. */
export interface VolumeFigure { baseline: number | null; candidate: number | null; relativeDifference: number | null }

export interface VolumeComparability {
  inputBytes: VolumeFigure;
  outputRows: VolumeFigure;
  outputBytes: VolumeFigure;
  /** Output rows are equal, and input and output bytes are within the noise band. Null when no
   * figure is measured on both sides. */
  equal: boolean | null;
}

export interface CapacityComparability {
  baseline: { meanExecutors: number | null; peakExecutors: number | null };
  candidate: { meanExecutors: number | null; peakExecutors: number | null };
}

export interface BridgeFactor { baseline: number | null; candidate: number | null; ratio: number | null }

/** wall clock = task time / (mean executors x cores x task time's share of allocated core time),
 * so for runs with equal executor cores the wall-clock ratio is the task-time ratio over the
 * product of the other two. `explainedWallClock` is that quotient. */
export interface WallClockBridge {
  wallClock: BridgeFactor;
  taskTime: BridgeFactor;
  meanExecutors: BridgeFactor;
  taskShareOfAllocation: BridgeFactor;
  explainedWallClock: number | null;
}

/** Differences between the runs that make a time difference unreliable to read. Each field is
 * null when its difference stays within the matching `CaveatThresholds` entry. */
export interface Caveats {
  /** Mean executors differ by more than `executorRatio`, in either direction. */
  executors: { baseline: number; candidate: number } | null;
  /** More than `unmatchedShare` of the baseline's stages pair with no candidate stage, counting the
   * stages left over in replanned groups. `runtimeShare` is those stages' share of the baseline's
   * executor run time, null when it is unmeasured. */
  unmatchedStages: { count: number; of: number; runtimeShare: number | null } | null;
  /** The task count changed by more than `taskCountChange`; `change` is relative to the baseline. */
  taskCount: { baseline: number; candidate: number; change: number } | null;
  /** The runs ran in different YARN queues; a side that does not set one is null. */
  queue: { baseline: string | null; candidate: string | null } | null;
  /** The jar or Python file paths differ (`spark.jars`, `spark.submit.pyFiles`, `spark.yarn.dist.*`),
   * a likely code change; null when none differs. */
  codeFiles: ConfDifference[] | null;
}

export interface CaveatThresholds {
  /** Factor, 1 or more, by which mean executors differ. */
  executorRatio: number;
  /** Share, 0 to 1, of the baseline's stages that pair with none. */
  unmatchedShare: number;
  /** Share, 0 or more, by which the task count changes. */
  taskCountChange: number;
}

export interface Comparability {
  /** The share of the baseline's value under which a figure counts as within noise. */
  noiseBand: number;
  conf: ConfComparability;
  plan: PlanComparability;
  volume: VolumeComparability;
  capacity: CapacityComparability;
  /** Milliseconds both run windows cover; null when a run's window is unknown. */
  overlapMs: number | null;
  wallClockBridge: WallClockBridge;
  caveats: Caveats;
}

export interface ComparabilityOptions {
  /** Regular expression sources: a configuration key that matches one is left out of `conf`. */
  ignoreConf?: readonly string[];
  /** Extra secret pattern, as the run output's `confRedactRegex`: a matching property is withheld. */
  confRedactRegex?: string;
  /** Share of the baseline's value under which a figure counts as within noise. */
  noiseBand: number;
  caveatThresholds: CaveatThresholds;
}

/** Keys the cluster sets per run (application id, start time, driver address). Two runs of one job
 * always differ here, so they never count as a configuration difference. */
const RUN_IDENTITY_CONF = /^spark\.(app\.(id|startTime|submitTime)|driver\.(host|port)|yarn\.app\.id|ui\.port)$/;

/** Compiles the caller's ignore patterns, matched against configuration keys. Throws on a
 * non-string or empty pattern, an over-long one, an invalid one, or too many. */
export function compileConfIgnorePatterns(patterns: readonly string[] | undefined): RegExp[] {
  if (!patterns || patterns.length === 0) return [];
  if (patterns.length > MAX_NORMALIZE_PATTERNS) {
    throw new Error(`At most ${MAX_NORMALIZE_PATTERNS} ignore patterns are accepted, got ${patterns.length}.`);
  }
  return patterns.map((source) => {
    if (typeof source !== 'string' || source.length === 0) throw new Error('An ignore pattern must be a non-empty string.');
    if (source.length > MAX_NORMALIZE_PATTERN_LENGTH) {
      throw new Error(`Ignore pattern "${source.slice(0, 40)}..." is ${source.length} characters; the limit is ${MAX_NORMALIZE_PATTERN_LENGTH}.`);
    }
    try {
      return new RegExp(source);
    } catch (e) {
      throw new Error(`Ignore pattern "${source}" is not a valid regular expression: ${(e as Error).message}`);
    }
  });
}

function compareConf(baseSnap: SessionSnapshot, candSnap: SessionSnapshot, ignore: RegExp[], userPattern?: string): ConfComparability {
  const base = buildEffectiveConf(baseSnap.app, { userPattern });
  const cand = buildEffectiveConf(candSnap.app, { userPattern });
  if (base == null || cand == null) return { equal: null, differences: [], ignoredKeys: [], withheldKeys: [] };
  const withheld = new Set([...base.maskedKeys, ...cand.maskedKeys]);
  const keys = [...new Set([...Object.keys(base.values), ...Object.keys(cand.values)])].filter((key) => !withheld.has(key)).sort();
  const differences: ConfDifference[] = [];
  const ignoredKeys: string[] = [];
  for (const key of keys) {
    const baseline = base.values[key] ?? null;
    const candidate = cand.values[key] ?? null;
    if (baseline === candidate) continue;
    if (RUN_IDENTITY_CONF.test(key) || ignore.some((pattern) => pattern.test(key))) ignoredKeys.push(key);
    else differences.push({ key, baseline, candidate });
  }
  return { equal: differences.length === 0, differences, ignoredKeys, withheldKeys: [...withheld].sort() };
}

function comparePlan(alignment: Pick<StageAlignment, 'unmatched' | 'replanned'>): PlanComparability {
  const unmatched = { baseline: alignment.unmatched.baseStageIds.length, candidate: alignment.unmatched.candStageIds.length };
  return {
    equal: unmatched.baseline === 0 && unmatched.candidate === 0 && alignment.replanned.length === 0,
    unmatched,
    replanned: alignment.replanned.length,
  };
}

const QUEUE_CONF_KEY = 'spark.yarn.queue';
const CODE_FILE_CONF = /^spark\.(jars|submit\.pyFiles|yarn\.dist\..+)$/;

function buildCaveats(
  baseSnap: SessionSnapshot, alignment: Pick<StageAlignment, 'unmatched' | 'replanned' | 'bookkeepingStageIds'>, conf: ConfComparability,
  meanExecutors: BridgeFactor, taskTime: BridgeFactor, tasks: VolumeFigure, thresholds: CaveatThresholds,
): Caveats {
  const { ratio } = meanExecutors;
  const unmatchedStages = [...alignment.unmatched.baseStageIds, ...alignment.replanned.flatMap((g) => g.baseStageIds)]
    .map((id) => baseSnap.stages.get(id)!);
  const stageCount = baseSnap.stages.size - alignment.bookkeepingStageIds.baseStageIds.length;
  const unmatchedRunTime = withEarlierAttempts(unmatchedStages).reduce((sum, stage) => sum + (stage.executorRunTime ?? 0), 0);
  const queue = conf.differences.find((d) => d.key === QUEUE_CONF_KEY);
  const codeFiles = conf.differences.filter((d) => CODE_FILE_CONF.test(d.key));
  return {
    executors: ratio != null && Math.max(ratio, 1 / ratio) > thresholds.executorRatio
      ? { baseline: meanExecutors.baseline!, candidate: meanExecutors.candidate! } : null,
    unmatchedStages: stageCount > 0 && unmatchedStages.length / stageCount > thresholds.unmatchedShare
      ? { count: unmatchedStages.length, of: stageCount, runtimeShare: taskTime.baseline ? unmatchedRunTime / taskTime.baseline : null } : null,
    taskCount: tasks.relativeDifference != null && Math.abs(tasks.relativeDifference) > thresholds.taskCountChange
      ? { baseline: tasks.baseline!, candidate: tasks.candidate!, change: tasks.relativeDifference } : null,
    queue: queue ? { baseline: queue.baseline, candidate: queue.candidate } : null,
    codeFiles: codeFiles.length > 0 ? codeFiles : null,
  };
}

function relativeDifference(baseline: number | null, candidate: number | null): number | null {
  if (baseline == null || candidate == null) return null;
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (candidate - baseline) / Math.abs(baseline);
}

function figure(baseline: number | null, candidate: number | null): VolumeFigure {
  return { baseline, candidate, relativeDifference: relativeDifference(baseline, candidate) };
}

/** Whether two measured values sit within `noiseBand` of the baseline. A baseline of 0 only
 * matches a candidate of 0. */
export function withinBand(baseline: number, candidate: number, noiseBand: number): boolean {
  if (baseline === 0) return candidate === 0;
  return Math.abs(candidate - baseline) / Math.abs(baseline) < noiseBand;
}

function compareVolume(
  baseStages: Stage[], candStages: Stage[], metrics: Array<{ key: string; baseline: number | null; candidate: number | null }>, noiseBand: number,
): VolumeComparability {
  const row = (key: string) => metrics.find((m) => m.key === key);
  const inputBytes = figure(row('inputBytes')?.baseline ?? null, row('inputBytes')?.candidate ?? null);
  const outputBytes = figure(row('outputBytes')?.baseline ?? null, row('outputBytes')?.candidate ?? null);
  const outputRows = figure(totalOutputRows(baseStages), totalOutputRows(candStages));
  const verdicts: boolean[] = [];
  for (const fig of [inputBytes, outputBytes]) {
    if (fig.baseline != null && fig.candidate != null) verdicts.push(withinBand(fig.baseline, fig.candidate, noiseBand));
  }
  if (outputRows.baseline != null && outputRows.candidate != null) verdicts.push(outputRows.baseline === outputRows.candidate);
  const outputMeasured = [outputRows, outputBytes].some((fig) => fig.baseline != null && fig.candidate != null);
  return { inputBytes, outputRows, outputBytes, equal: !outputMeasured ? null : verdicts.every(Boolean) };
}

function ratio(baseline: number | null, candidate: number | null): number | null {
  return baseline == null || candidate == null || baseline === 0 ? null : candidate / baseline;
}

function factor(baseline: number | null, candidate: number | null): BridgeFactor {
  return { baseline, candidate, ratio: ratio(baseline, candidate) };
}

function runWindow(snap: SessionSnapshot): [number, number] | null {
  const start = snap.app?.startTime;
  const end = snap.app?.endTime ?? (snap.executors ? lastObservedTimestamp(snap) : null);
  return start != null && end != null && end >= start ? [start, end] : null;
}

/** The comparability facts of a comparison. `metrics` are the comparison's own rows, so the
 * volume and bridge figures are the ones the metrics table shows. */
export function buildComparability(
  baseSnap: SessionSnapshot, candSnap: SessionSnapshot,
  alignment: Pick<StageAlignment, 'unmatched' | 'replanned' | 'bookkeepingStageIds'>,
  metrics: Array<{ key: string; baseline: number | null; candidate: number | null }>,
  { ignoreConf, confRedactRegex, noiseBand, caveatThresholds }: ComparabilityOptions,
): Comparability {
  const attempts = (snap: SessionSnapshot): Stage[] => withEarlierAttempts([...snap.stages.values()]);
  const allocation = (snap: SessionSnapshot) => (snap.executors ? computeAllocation(snap) : null);
  const baseAlloc = allocation(baseSnap), candAlloc = allocation(candSnap);
  const row = (key: string) => metrics.find((m) => m.key === key);
  const share = (snap: SessionSnapshot, runTimeMs: number | null): number | null => {
    const allocated = snap.executors ? allocatedCoreMs(snap) : null;
    return runTimeMs != null && allocated != null ? runTimeMs / allocated : null;
  };
  const taskTime = factor(row('executorRunTime')?.baseline ?? null, row('executorRunTime')?.candidate ?? null);
  const meanExecutors = factor(baseAlloc?.executorsMean ?? null, candAlloc?.executorsMean ?? null);
  const taskShare = factor(share(baseSnap, taskTime.baseline), share(candSnap, taskTime.candidate));
  const parts = [taskTime.ratio, meanExecutors.ratio, taskShare.ratio];
  const explainedWallClock = parts.every((r): r is number => r != null && r > 0)
    ? parts[0]! / (parts[1]! * parts[2]!)
    : null;

  const conf = compareConf(baseSnap, candSnap, compileConfIgnorePatterns(ignoreConf), confRedactRegex);
  const baseWindow = runWindow(baseSnap), candWindow = runWindow(candSnap);
  const overlapMs = baseWindow && candWindow
    ? Math.max(0, Math.min(baseWindow[1], candWindow[1]) - Math.max(baseWindow[0], candWindow[0]))
    : null;

  return {
    noiseBand,
    conf,
    plan: comparePlan(alignment),
    volume: compareVolume(attempts(baseSnap), attempts(candSnap), metrics, noiseBand),
    capacity: {
      baseline: { meanExecutors: baseAlloc?.executorsMean ?? null, peakExecutors: baseAlloc?.executorsPeak ?? null },
      candidate: { meanExecutors: candAlloc?.executorsMean ?? null, peakExecutors: candAlloc?.executorsPeak ?? null },
    },
    overlapMs,
    wallClockBridge: {
      wallClock: factor(row('wallClock')?.baseline ?? null, row('wallClock')?.candidate ?? null),
      taskTime,
      meanExecutors,
      taskShareOfAllocation: taskShare,
      explainedWallClock,
    },
    caveats: buildCaveats(baseSnap, alignment, conf, meanExecutors, taskTime, figure(row('taskCount')?.baseline ?? null, row('taskCount')?.candidate ?? null), caveatThresholds),
  };
}
