import type { Finding } from '@sparkforensics/core/types.ts';
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
 * multi-stage or app-level finding stands alone by its own type, since two
 * different app-level problems are not the same place. */
export function locationKey(finding: Finding): { key: string; stageId: number | null } {
  if (typeof finding.stageId === 'number') return { key: `stage:${finding.stageId}`, stageId: finding.stageId };
  if (finding.stageIds && finding.stageIds.length === 1) {
    return { key: `stage:${finding.stageIds[0]}`, stageId: finding.stageIds[0] };
  }
  if (finding.stageIds && finding.stageIds.length > 1) {
    return { key: `stages:${finding.type}:${[...finding.stageIds].sort((a, b) => a - b).join(',')}`, stageId: null };
  }
  return { key: `app:${finding.type}`, stageId: null };
}

/** Groups every routeable finding by location, ordered by the location's
 * best-ranked finding (the same potential-savings ranking the triage route
 * uses), so step 1 is always the run's single biggest win. */
export function buildNextSteps(findings: Finding[]): NextStep[] {
  const steps = new Map<string, NextStep>();
  for (const target of rankTriageTargets(findings)) {
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

/** Finding types whose step is about executor capacity sitting idle. */
const IDLE_CAPACITY_TYPES = new Set(['memoryUtilization', 'utilization']);

/** Idle-capacity share (the Scorecard's Wastage tile) that the verdict treats
 * as the run's main story on its own: the Wastage tile's critical flag. */
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
  const idleIndex = steps.findIndex((step) => IDLE_CAPACITY_TYPES.has(step.lead.finding.type));
  if (idleIndex <= 0) return steps;
  const leadSavings = steps[0].lead.finding.impactEstimate?.wallClock?.high ?? 0;
  const smallFirstFix = runMs != null && runMs > 0 && leadSavings / runMs < SMALL_FIRST_FIX_SHARE;
  const idleLeads = idlePct >= IDLE_DOMINANT_PCT || (idlePct >= IDLE_NOTABLE_PCT && smallFirstFix);
  if (!idleLeads) return steps;
  return [steps[idleIndex], ...steps.slice(0, idleIndex), ...steps.slice(idleIndex + 1)];
}

export function isIdleCapacityStep(step: NextStep): boolean {
  return IDLE_CAPACITY_TYPES.has(step.lead.finding.type);
}
