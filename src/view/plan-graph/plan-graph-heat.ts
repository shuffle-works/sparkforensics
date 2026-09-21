import type { ImpactBand } from '@sparkforensics/core/types.ts';

// Plan-graph-specific magnitude thresholds for the heat bar. Deliberately
// NOT impact-band.ts's IMPACT_FLOOR_PCT_CRIT/_WARN: those grade a finding's
// recoverable wall-clock time as a fraction of the WHOLE APP's duration;
// this grades a node's share of the PLAN's total attributed stage wall time
// (the sum across every stage in the SQL execution's plan, not one stage).
// Reusing one number for two different ratios is the exact class of bug the
// Exchange-detection consolidation in this same change otherwise fixes elsewhere.
// Placeholder defaults per the 2026-09-16 design spec; tune against real logs.
export const PLAN_GRAPH_HEAT_CRIT_PCT = 40;
export const PLAN_GRAPH_HEAT_WARN_PCT = 15;

export function heatBand(durationSharePct: number | null): ImpactBand | null {
  if (durationSharePct == null) return null;
  if (durationSharePct >= PLAN_GRAPH_HEAT_CRIT_PCT) return 'critical';
  if (durationSharePct >= PLAN_GRAPH_HEAT_WARN_PCT) return 'warning';
  return 'info';
}
