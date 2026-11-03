// The run's shape as the dashboard's Scorecard, ETL Phase Attribution and Core Usage by Locality
// cards show it, for the CLI/MCP paths: every figure comes from the same core function those cards
// read, and null means the card would show "Not measured" or "Unavailable".
import { hasFinishedStage } from './check-coverage.ts';
import { buildLocalityChart } from './core-usage-locality.ts';
import { attributeEtlPhases } from './etl-phases.ts';
import type { ThresholdOverrides } from './detectors.ts';
import { gradeIdlePct, idleGrading } from './idle-grading.ts';
import { runTiming } from './run-timing.ts';
import { getScorecardEstimates } from './scorecard-estimates.ts';
import type { AppModel } from './types.ts';

export type ScorecardFlag = 'critical' | 'warning' | null;

export interface RunShape {
  /** Whole-run wall-clock, or null without a complete application timing interval. */
  wallClockMs: number | null;
  /** The Scorecard's Efficiency: share of wall-clock with a stage running. Null when no stage
   * finished or the timing interval is incomplete. */
  efficiencyPct: number | null;
  /** The Scorecard's Unused core time: driver idle plus executor slack as a share of available
   * core time. `100 - unusedCoreTimePct` is what the `--min-efficiency` budget checks. */
  unusedCoreTimePct: number | null;
  /** How bad `efficiencyPct` is: critical under 75, warning under 90. */
  efficiencyFlag: ScorecardFlag;
  /** How bad `unusedCoreTimePct` is, graded by the `utilization` detector's thresholds. */
  unusedCoreTimeFlag: ScorecardFlag;
  /** Summed stage time per ETL phase (a stage can count in more than one), in ms. Null when no
   * stage time is attributable to any phase. */
  etlPhasesMs: { extract: number; transform: number; load: number } | null;
  /** Busy cores at the peak of the Core Usage by Locality chart, or null with no plottable
   * stage activity. */
  peakBusyCores: number | null;
}

// The Scorecard's severity rule: a tile is flagged only when the figure is bad enough to act on.
function efficiencyFlag(pct: number | null): ScorecardFlag {
  if (pct == null) return null;
  return pct < 75 ? 'critical' : pct < 90 ? 'warning' : null;
}

export function computeRunShape(appModel: AppModel, thresholds?: ThresholdOverrides): RunShape {
  const timing = runTiming(appModel.app, appModel.stages);
  const estimates = getScorecardEstimates(appModel);
  const phases = attributeEtlPhases(appModel.stages);
  const chart = buildLocalityChart([...appModel.stages.values()], appModel.app);
  const efficiencyPct = hasFinishedStage(appModel.stages) ? estimates.efficiency.value : null;
  return {
    wallClockMs: timing.durationMs,
    efficiencyPct,
    unusedCoreTimePct: estimates.wastage.value,
    efficiencyFlag: efficiencyFlag(efficiencyPct),
    unusedCoreTimeFlag: gradeIdlePct(estimates.wastage.value, idleGrading(thresholds)),
    etlPhasesMs: phases.extract + phases.transform + phases.load > 0 ? phases : null,
    peakBusyCores: chart.hasActivity ? chart.peakCores : null,
  };
}
