// How bad a run's idle share is, from the `utilization` detector's own thresholds: the finding
// fires under `minUtil` busy, so the verdict note and the Scorecard flag treat the same share as
// notable, and `criticalUtil` busy as critical. A `--thresholds` override moves all three together.
import { ENTRY_BY_TYPE } from './detector-catalog.ts';
import type { ThresholdOverrides } from './detectors.ts';
import { effectiveThresholds } from './threshold-overrides.ts';

export type IdleGrade = 'critical' | 'warning' | null;

export interface IdleGrading {
  /** Idle percentage from which the run's idle share is worth stating. */
  notablePct: number;
  /** Idle percentage from which it is critical. */
  criticalPct: number;
}

export function idleGrading(overrides?: ThresholdOverrides): IdleGrading {
  const { minUtil, criticalUtil } = effectiveThresholds(ENTRY_BY_TYPE.get('utilization')!, overrides) as { minUtil: number; criticalUtil: number };
  return { notablePct: Math.round((1 - minUtil) * 100), criticalPct: Math.round((1 - criticalUtil) * 100) };
}

export function gradeIdlePct(idlePct: number | null, grading: IdleGrading): IdleGrade {
  if (idlePct == null) return null;
  return idlePct >= grading.criticalPct ? 'critical' : idlePct >= grading.notablePct ? 'warning' : null;
}
