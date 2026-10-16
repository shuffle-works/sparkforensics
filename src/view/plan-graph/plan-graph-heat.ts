import type { ImpactBand } from '@sparkforensics/core/types.ts';

// Heat-bar thresholds, deliberately NOT impact-band.ts's IMPACT_FLOOR_PCT_CRIT/_WARN:
// those grade a finding's recoverable time against the whole app's duration;
// this grades a node's share of the plan's total attributed stage wall time
// (summed across every stage in the SQL execution's plan). Two different ratios
// must not share one number. Starting values, not calibrated on real logs.
export const PLAN_GRAPH_HEAT_CRIT_PCT = 40;
export const PLAN_GRAPH_HEAT_WARN_PCT = 15;

export function heatBand(durationSharePct: number | null): ImpactBand | null {
  if (durationSharePct == null) return null;
  if (durationSharePct >= PLAN_GRAPH_HEAT_CRIT_PCT) return 'critical';
  if (durationSharePct >= PLAN_GRAPH_HEAT_WARN_PCT) return 'warning';
  return 'info';
}
