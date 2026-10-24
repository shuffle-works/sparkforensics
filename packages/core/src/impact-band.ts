import type { Finding, SparkAppInfo, Stage } from './types.ts';
import { stageTaskMs } from './impact-model.ts';
import { FAILURE_TYPES } from './run-outcome.ts';
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
  if (app?.startTime == null || app?.endTime == null) return null;
  const durationMs = app.endTime - app.startTime;
  return durationMs > 0 ? durationMs : null;
}

/**
 * Overwrites `.impactBand` for any finding with a quantified wall-clock estimate, grading it purely
 * by recoverable time as a fraction of the run's duration: a full replace (either direction), not a
 * promote-only floor. Findings with no wallClock estimate (resourceOnly/informational), an
 * unknown/zero app duration, or an explicit safety-signal exemption (partitionSizing's
 * maxPartitionTooBig rule) are left as the detector set them. Mutates in place and returns the array.
 *
 * Grades wallClock.high (matching triage-target/FixTheseFirst, which rank by the same optimistic
 * figure), a deliberate split from view/impact-sort.ts's 'impact' sort, which ranks by .low so an
 * optimistic-but-contended finding never outranks a smaller certain one. Same range, two fields for
 * two questions.
 *
 * `floorsFor` supplies a finding type's floors when a tuned run moved them (skew's and straggler's
 * own floorPctWarn/floorPctCrit); omitted, or for any type it returns nothing, the defaults above.
 */
export function deriveImpactBand(
  findings: Finding[], app: SparkAppInfo | null, floorsFor?: (type: string) => ImpactBandFloors | null,
): Finding[] {
  const durationMs = appDurationMs(app);
  if (durationMs == null) return findings;
  for (const finding of findings) {
    // maxPartitionTooBig is a hardcoded-critical OOM/crash-risk safety signal, not a
    // time-recovery one, yet it carries a real wallClock estimate (unlike the other hardcoded-
    // critical findings, which stay costOnly/informational and are exempted below by having no
    // wallClock at all). Exempt it explicitly so a long-running job never demotes an active
    // crash risk down to 'info' just because fixing it saves little wall-clock time relative to
    // the run.
    if (finding.type === 'partitionSizing' && finding.rule === 'maxPartitionTooBig') continue;
    const recoverableMs = finding.impactEstimate?.wallClock?.high;
    if (recoverableMs == null) continue;
    const pct = recoverableMs / durationMs;
    const { warnPct, critPct } = floorsFor?.(finding.type) ?? DEFAULT_FLOORS;
    finding.impactBand = pct >= critPct ? 'critical' : pct >= warnPct ? 'warning' : 'info';
  }
  return findings;
}

/**
 * Caps a `critical` band at `warning` when the finding's stage carries under
 * CRITICAL_MIN_TASK_TIME_SHARE of the run's task time. Failures and partitionSizing's
 * maxPartitionTooBig stay critical whatever the stage costs, and a finding with no single stage or
 * no recorded task time has nothing to compare. Mutates in place and returns the array.
 */
export function capCriticalByTaskTime(findings: Finding[], stages: Map<number, Stage>): Finding[] {
  let runTaskMs = 0;
  for (const stage of stages.values()) runTaskMs += stageTaskMs(stage);
  if (runTaskMs <= 0) return findings;
  for (const finding of findings) {
    if (finding.impactBand !== 'critical') continue;
    if (FAILURE_TYPES.has(finding.type)) continue;
    if (finding.type === 'partitionSizing' && finding.rule === 'maxPartitionTooBig') continue;
    const stageId = singleStageId(finding);
    const stage = stageId == null ? undefined : stages.get(stageId);
    const taskMs = stage ? stageTaskMs(stage) : 0;
    if (taskMs > 0 && taskMs / runTaskMs < CRITICAL_MIN_TASK_TIME_SHARE) finding.impactBand = 'warning';
  }
  return findings;
}
