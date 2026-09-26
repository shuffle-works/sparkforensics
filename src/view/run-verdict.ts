import { isRealFinding } from '@sparkforensics/core/recommendation-rollup.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { formatRawWaste, formatWallClockRange, readsAsZero } from '@/view/ImpactEstimate';
import { FAILURE_TYPES, summarizeRunOutcome } from '@/view/run-outcome';
import { rankTriageTargets, type TriageTarget } from '@/view/triage-target';

/** How many next steps the verdict lists before pointing at the full list. */
export const NEXT_STEP_LIMIT = 3;

/** One place worth a look: the highest-ranked finding at a location, plus the
 * other finding types flagged at that same location. Findings that share a
 * stage usually share one root cause, so they read as one step, not several. */
export interface NextStep {
  key: string;
  lead: TriageTarget;
  /** Other findings at the same location, one per finding type, lead excluded. */
  related: Finding[];
  /** The location's single stage, when it has exactly one. */
  stageId: number | null;
}

/** A finding's location identity for grouping. Per-stage findings (and
 * sql-scope findings that touch exactly one stage) group by that stage; a
 * multi-stage or app-level finding stands alone by its own type (and variant,
 * for app-level ones), since two different app-level problems are not the
 * same place. */
export function locationKey(finding: Finding): { key: string; stageId: number | null } {
  if (typeof finding.stageId === 'number') return { key: `stage:${finding.stageId}`, stageId: finding.stageId };
  if (finding.stageIds && finding.stageIds.length === 1) {
    return { key: `stage:${finding.stageIds[0]}`, stageId: finding.stageIds[0] };
  }
  if (finding.stageIds && finding.stageIds.length > 1) {
    return { key: `stages:${finding.type}:${[...finding.stageIds].sort((a, b) => a - b).join(',')}`, stageId: null };
  }
  return { key: finding.variant ? `app:${finding.type}:${finding.variant}` : `app:${finding.type}`, stageId: null };
}

/** 0 for a failure at a stage of a failed job (what stopped the job), 1 for
 * any other failure finding, 2 for everything else. */
function failureRank(finding: Finding, failedJobStageIds: ReadonlySet<number>): number {
  if (!FAILURE_TYPES.has(finding.type)) return 2;
  return typeof finding.stageId === 'number' && failedJobStageIds.has(finding.stageId) ? 0 : 1;
}

/** Groups every routeable finding by location, ordered by the location's
 * best-ranked finding (the same potential-savings ranking the triage route
 * uses), so step 1 is always the run's single biggest win. With
 * `failedJobStageIds` (a run whose jobs failed), failure findings rank ahead
 * of every savings figure and lead their location, those at a failed job's
 * stage first: a speed-up is moot until the job finishes. */
export function buildNextSteps(findings: Finding[], { failedJobStageIds }: { failedJobStageIds?: ReadonlySet<number> } = {}): NextStep[] {
  const ranked = rankTriageTargets(findings);
  // Array.prototype.sort is stable, so savings order holds within each rank.
  const ordered = failedJobStageIds
    ? [...ranked].sort((a, b) => failureRank(a.finding, failedJobStageIds) - failureRank(b.finding, failedJobStageIds))
    : ranked;
  const steps = new Map<string, NextStep>();
  for (const target of ordered) {
    const { key, stageId } = locationKey(target.finding);
    const existing = steps.get(key);
    if (!existing) {
      steps.set(key, { key, lead: target, related: [], stageId });
      continue;
    }
    const seenTypes = new Set([existing.lead.finding.type, ...existing.related.map((f) => f.type)]);
    if (!seenTypes.has(target.finding.type)) existing.related.push(target.finding);
  }
  return [...steps.values()];
}

/** True for findings about executor capacity sitting idle. memoryUtilization
 * also reports heap pressure and over-provisioning, which are not idle
 * capacity, so only its idleCores variant counts. */
function isIdleCapacityFinding(finding: Finding): boolean {
  return finding.type === 'utilization' || (finding.type === 'memoryUtilization' && finding.variant === 'idleCores');
}

/** Idle share at which the verdict notes, in its summary, that the cluster
 * may be larger than the job needs. It never reorders the steps. */
export const IDLE_NOTABLE_PCT = 40;

export function isIdleCapacityStep(step: NextStep): boolean {
  return isIdleCapacityFinding(step.lead.finding);
}

/** The idle share an idle-capacity finding itself reports: idleCores carries
 * the idle rate, utilization the busy rate. Null for any other finding. */
function reportedIdlePct(finding: Finding): number | null {
  if (typeof finding.value !== 'number') return null;
  if (finding.type === 'memoryUtilization' && finding.variant === 'idleCores') return finding.value;
  if (finding.type === 'utilization') return 100 - finding.value;
  return null;
}

/** The run's idle share as the verdict states it: the figure the top-ranked
 * idle-capacity step reports, so the verdict never disagrees with that step,
 * or `fallbackPct` (the Scorecard's Unused core time) when no step reports one. */
export function verdictIdlePct(steps: NextStep[], fallbackPct: number | null): number | null {
  const idleStep = steps.find(isIdleCapacityStep);
  return (idleStep ? reportedIdlePct(idleStep.lead.finding) : null) ?? fallbackPct;
}

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

export function isIncompleteRun(allFindings: Finding[]): boolean {
  return allFindings.some((finding) => finding.type === 'incompleteRun');
}

/** What this log could not check, in plain sentences, each saying what to
 * turn on for the next run where the detector names it. */
export function verdictGaps(allFindings: Finding[], noFinishedStages: boolean): string[] {
  const gaps = new Set<string>();
  if (noFinishedStages) gaps.add('No stage in this log recorded an end, so the stage checks had nothing to measure.');
  if (isIncompleteRun(allFindings)) {
    gaps.add('The log has no end-of-run record, so the core usage, memory and executor churn checks had no run length to measure.');
  }
  for (const finding of allFindings) {
    if (isEvidenceCaveat(finding) && finding.recommendation) gaps.add(finding.recommendation);
  }
  return [...gaps];
}

/** The one rule for calling a run clean, shared by the verdict and the top
 * bar: no finding at all, no failed job, and nothing the log lacked to run a
 * check. */
export function isCleanRun(appModel: Pick<AppModel, 'jobs' | 'stages'>, allFindings: Finding[]): boolean {
  if (summarizeRunOutcome(appModel.jobs, allFindings).failedJobs > 0) return false;
  if (allFindings.some(isRealFinding)) return false;
  return verdictGaps(allFindings, !hasFinishedStage(appModel.stages)).length === 0;
}

/** What a step's savings figure counts, as the words that follow it: run
 * time for a wall-clock claim, or the resource a cost-only (`resourceOnly`)
 * figure measures. A time figure and a capacity figure look alike ("58.6s",
 * "0.7 core-h") but only the first shortens the run. Null when the step
 * shows no figure. */
export function savingsMeaning(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate) return null;
  if (estimate.wallClock) return 'of run time';
  switch (estimate.rawWaste?.unit) {
    case 'mbSeconds': return 'of unused executor memory';
    case 'coreHours':
    case 'coreMs': return 'of core time';
    case 'bytes': return 'of extra data written';
    case 'ms': return 'of task time';
    default: return null;
  }
}

/** How a step's savings figure was derived, in one plain sentence for
 * Advanced view: the estimate method, whether the stage ran alone (a
 * near-point figure) or shared the cluster (a floor and an optimistic high),
 * and the raw waste behind it. Null when the finding carries no estimate
 * model (`estimateMethod: 'none'`), no estimate at all, or a figure that
 * reads as zero (the step shows no savings then either). Uses the same
 * formatting and zero rules as the step's own savings figure. */
export function estimateProvenance(finding: Finding): string | null {
  const estimate = finding.impactEstimate;
  if (!estimate || estimate.estimateMethod === 'none') return null;
  const method = estimate.estimateMethod;
  const rawWaste = estimate.rawWaste && estimate.rawWaste.value > 0 ? estimate.rawWaste : null;
  const raw = rawWaste && !readsAsZero(formatRawWaste(rawWaste)) ? formatRawWaste(rawWaste) : null;
  const wallClock = estimate.wallClock;
  if (estimate.basis === 'resourceOnly') {
    return raw ? `No run-time claim, ${method}. ${raw} was wasted, but it may not shorten the run.` : null;
  }
  if (!wallClock || wallClock.high <= 0) return null;
  const highText = formatWallClockRange(wallClock.high, wallClock.high);
  if (readsAsZero(highText)) return null;
  let rawNote = '';
  if (raw && rawWaste!.unit !== 'ms') rawNote = ` Resource waste measured: ${raw}.`;
  else if (raw && rawWaste!.value > wallClock.high && raw !== highText) rawNote = ` Raw waste before the floor clipped it: ${raw}.`;
  if (estimate.basis === 'serial') {
    return `${highText}, ${method}. The stage ran effectively alone, so this is close to a point estimate.${rawNote}`;
  }
  if (estimate.basis === 'contended') {
    const lowText = formatWallClockRange(wallClock.low, wallClock.low);
    const range = formatWallClockRange(wallClock.low, wallClock.high);
    const spread = lowText === highText ? 'its floor and optimistic high agree' : `${lowText} is the floor, ${highText} assumes the fix fully lands`;
    return `${range}, ${method}. The stage shared the cluster with others: ${spread}.${rawNote}`;
  }
  return null;
}
