import type { Finding, Stage } from './types.ts';
import { stageTaskMs } from './impact-model.ts';
import { runTiming } from './run-timing.ts';
import { singleStageId } from './finding-filter-predicate.ts';

// The run-wide noise floor, as a share of the run's duration, that grades every wall-clock
// estimate. skew and straggler default their firing floors to these same figures (detectors.ts), so
// a finding they admit grades at least warning here. Source status: threshold-tables.md.
export const IMPACT_FLOOR_PCT_WARN = 0.005;
export const IMPACT_FLOOR_PCT_CRIT = 0.02;

// The share of the run's task time a stage must carry for a finding on it to stay `critical`: the
// IMPACT_FLOOR_PCT_CRIT figure, applied to task time.
export const CRITICAL_MIN_TASK_TIME_SHARE = IMPACT_FLOOR_PCT_CRIT;

/** The share-of-run floors one finding grades against. */
export interface ImpactBandFloors { warnPct: number; critPct: number }

const DEFAULT_FLOORS: ImpactBandFloors = { warnPct: IMPACT_FLOOR_PCT_WARN, critPct: IMPACT_FLOOR_PCT_CRIT };

/** The run's wall-clock duration, or null when unknown or non-positive: the denominator of both
 * this band and the detectors' runtime floors. */
export function appDurationMs(app: { startTime?: number | null; endTime?: number | null } | null): number | null {
  return runTiming(app).durationMs;
}

/**
 * How a detector's band reaches the report, declared on every entry:
 * - `derived`: graded by the recoverable wall-clock share of the run, then a critical band is
 *   capped at warning when the finding's stage carries little of the run's task time;
 * - `own`: the detector's own band stands, still capped by task time (it is not a time-recovery band);
 * - `failure`: the detector's own band stands whatever the stage costs.
 */
export type BandPolicy = 'derived' | 'own' | 'failure';

/** The slice of a detector entry grading reads. `gradeAs` names a finding the entry grades under
 * another policy (partitionSizing's OOM-risk rule stays critical). */
export interface BandEntry { bandPolicy: BandPolicy; gradeAs?: (finding: Finding) => BandPolicy }

type FloorsFor = (type: string) => ImpactBandFloors | null;

/** What grading reads of a run, computed once: its duration, its task time, and the floors a tuned
 * run moved (skew's and straggler's own floorPctWarn/floorPctCrit). */
export interface BandRun {
  durationMs: number | null;
  runTaskMs: number;
  stages: Map<number, Stage>;
  floorsFor?: FloorsFor;
}

export function bandRun(
  app: { startTime?: number | null; endTime?: number | null } | null, stages: Map<number, Stage>,
  floorsFor?: FloorsFor,
): BandRun {
  let runTaskMs = 0;
  for (const stage of stages.values()) runTaskMs += stageTaskMs(stage);
  return { durationMs: appDurationMs(app), runTaskMs, stages, floorsFor };
}

/**
 * Sets `.impactBand` under the entry's policy, in place. A `derived` finding with a quantified
 * wall-clock estimate on a run with a known duration is graded purely by `wallClock.high`, the
 * optimistic figure the verdict ranking uses, as a share of the run: a full replace in either
 * direction, not a promote-only floor. Every policy but `failure` then caps a critical band at
 * warning when the finding's single stage carries under CRITICAL_MIN_TASK_TIME_SHARE of the run's
 * task time; a finding with no single stage or no recorded task time has nothing to compare.
 */
export function gradeFinding(finding: Finding, entry: BandEntry, run: BandRun): void {
  const policy = entry.gradeAs?.(finding) ?? entry.bandPolicy;
  if (policy === 'failure') return;
  const recoverableMs = finding.impactEstimate?.wallClock?.high;
  if (policy === 'derived' && run.durationMs != null && recoverableMs != null) {
    const pct = recoverableMs / run.durationMs;
    const { warnPct, critPct } = run.floorsFor?.(finding.type) ?? DEFAULT_FLOORS;
    finding.impactBand = pct >= critPct ? 'critical' : pct >= warnPct ? 'warning' : 'info';
  }
  if (finding.impactBand !== 'critical' || run.runTaskMs <= 0) return;
  const stageId = singleStageId(finding);
  const stage = stageId == null ? undefined : run.stages.get(stageId);
  const taskMs = stage ? stageTaskMs(stage) : 0;
  if (taskMs > 0 && taskMs / run.runTaskMs < CRITICAL_MIN_TASK_TIME_SHARE) finding.impactBand = 'warning';
}
