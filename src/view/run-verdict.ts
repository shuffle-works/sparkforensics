import type { Finding } from '@sparkforensics/core/types.ts';
import { FAILURE_TYPES } from '@/view/run-outcome';
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

/** Idle-capacity share that the verdict treats as the run's main story on its
 * own: the Scorecard's Unused core time critical flag. */
export const IDLE_DOMINANT_PCT = 70;
/** Idle share that still leads when the best time-based fix is tiny. */
export const IDLE_NOTABLE_PCT = 40;
/** "Tiny" first fix: under this share of the run's wall-clock. */
const SMALL_FIRST_FIX_SHARE = 0.05;

/** Moves the idle-capacity step to the front when idle capacity, not any one
 * time-based fix, is the run's main problem. Detectors band each finding on
 * its own scale, so a 64ms skew fix can outrank a run that left 92% of its
 * cores idle; the verdict orders by what matters for this run. Returns the
 * steps unchanged when no idle-capacity step exists. */
export function prioritizeIdleCapacity(steps: NextStep[], idlePct: number | null, runMs: number | null): NextStep[] {
  if (idlePct == null || steps.length < 2) return steps;
  const idleIndex = steps.findIndex(isIdleCapacityStep);
  if (idleIndex <= 0) return steps;
  const leadSavings = steps[0].lead.finding.impactEstimate?.wallClock?.high ?? 0;
  const smallFirstFix = runMs != null && runMs > 0 && leadSavings / runMs < SMALL_FIRST_FIX_SHARE;
  const idleLeads = idlePct >= IDLE_DOMINANT_PCT || (idlePct >= IDLE_NOTABLE_PCT && smallFirstFix);
  if (!idleLeads) return steps;
  return [steps[idleIndex], ...steps.slice(0, idleIndex), ...steps.slice(idleIndex + 1)];
}

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
