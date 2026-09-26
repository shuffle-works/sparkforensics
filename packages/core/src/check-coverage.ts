// Which checks a log could actually run. Shared by the dashboard (verdict, top bar, Clean checks)
// and the CLI/MCP evidence report, so a check the log lacked the data for never reads as passed on
// one path and "not checked" on another.
import { detectorCatalog } from './detectors.ts';
import { isRealFinding } from './recommendation-rollup.ts';
import { summarizeRunOutcome } from './run-outcome.ts';
import type { AppModel, Finding } from './types.ts';

export const NO_FINISHED_STAGE_GAP = 'No stage in this log recorded an end, so the stage checks had nothing to measure.';
export const INCOMPLETE_RUN_GAP =
  'The log has no end-of-run record, so the core usage, memory and executor churn checks had no run length to measure.';

/** True when at least one stage recorded both a start and an end, so the
 * stage checks had something to measure. */
export function hasFinishedStage(stages: AppModel['stages']): boolean {
  return [...stages.values()].some((stage) => stage.submittedAt != null && stage.completedAt != null);
}

/** A finding that reports a check could not run for lack of evidence (cache
 * storage without block updates, memory without executor metrics), rather
 * than a problem found. Its recommendation names the setting to turn on. */
export function isEvidenceCaveat(finding: Finding): boolean {
  return finding.dataUnavailable === true || !isRealFinding(finding);
}

/** App-level checks measured over the run's full span, which a log with no
 * ApplicationEnd (an `incompleteRun` finding) cannot give them. */
export const RUN_SPAN_CHECK_TYPES: ReadonlySet<string> = new Set(['utilization', 'memoryUtilization', 'autoscalingChurn']);

/** Detector types that measure each stage, read from the detector catalog. */
export const PER_STAGE_CHECK_TYPES: ReadonlySet<string> = new Set(
  detectorCatalog().filter((entry) => entry.scope === 'stage').map((entry) => entry.type),
);

export function isIncompleteRun(allFindings: Finding[]): boolean {
  return allFindings.some((finding) => finding.type === 'incompleteRun');
}

/** What this log could not check, in plain sentences, each saying what to
 * turn on for the next run where the detector names it. */
export function verdictGaps(allFindings: Finding[], noFinishedStages: boolean): string[] {
  const gaps = new Set<string>();
  if (noFinishedStages) gaps.add(NO_FINISHED_STAGE_GAP);
  if (isIncompleteRun(allFindings)) gaps.add(INCOMPLETE_RUN_GAP);
  for (const finding of allFindings) {
    if (isEvidenceCaveat(finding) && finding.recommendation) gaps.add(finding.recommendation);
  }
  return [...gaps];
}

/** The one rule for calling a run clean, shared by the verdict, the top bar
 * and the evidence report: no finding at all, no failed job, and nothing the
 * log lacked to run a check. */
export function isCleanRun(appModel: Pick<AppModel, 'jobs' | 'stages'>, allFindings: Finding[]): boolean {
  if (summarizeRunOutcome(appModel.jobs, allFindings).failedJobs > 0) return false;
  if (allFindings.some(isRealFinding)) return false;
  return verdictGaps(allFindings, !hasFinishedStage(appModel.stages)).length === 0;
}

export interface CheckCoverage {
  /** True when the log lacked the data this check type needs, so it neither passed nor failed. */
  isNotRun(type: string): boolean;
  /** Why this check type could not run, or null when it could. An evidence caveat's own
   * recommendation (it names the setting to turn on) wins over the log-wide reasons. */
  notRunReason(type: string): string | null;
}

/** The not-run rule for one run: an evidence caveat of that type, a per-stage
 * check on a log where no stage finished, or a run-span check on a log with
 * no ApplicationEnd. */
export function checkCoverage(stages: AppModel['stages'], allFindings: Finding[]): CheckCoverage {
  const noFinishedStages = !hasFinishedStage(stages);
  const incomplete = isIncompleteRun(allFindings);
  const caveatReasons = new Map<string, string | null>();
  for (const finding of allFindings) {
    if (!isEvidenceCaveat(finding)) continue;
    if (!caveatReasons.get(finding.type)) caveatReasons.set(finding.type, finding.recommendation ?? null);
  }
  const notRunReason = (type: string): string | null => {
    const caveatReason = caveatReasons.get(type);
    if (caveatReason) return caveatReason;
    if (noFinishedStages && PER_STAGE_CHECK_TYPES.has(type)) return NO_FINISHED_STAGE_GAP;
    if (incomplete && RUN_SPAN_CHECK_TYPES.has(type)) return INCOMPLETE_RUN_GAP;
    // A caveat with no recommendation still means the check did not run.
    return caveatReasons.has(type) ? 'The log lacked the data this check needs.' : null;
  };
  return { isNotRun: (type) => notRunReason(type) != null, notRunReason };
}
