// The run's shape as the dashboard's Scorecard, ETL Phase Attribution and Core Usage by Locality
// cards show it, for the CLI/MCP paths: every figure comes from the same core function those cards
// read, and null means the card would show "Not measured" or "Unavailable".
import { hasFinishedStage } from './check-coverage.ts';
import { buildLocalityChart } from './core-usage-locality.ts';
import { attributeEtlPhases } from './etl-phases.ts';
import { getScorecardEstimates, hasCompleteApplicationInterval } from './scorecard-estimates.ts';
import { computeWallClock } from './wall-clock.ts';
import type { AppModel } from './types.ts';

export interface RunShape {
  /** Whole-run wall-clock, or null without a complete application timing interval. */
  wallClockMs: number | null;
  /** The Scorecard's Efficiency: share of wall-clock with a stage running. Null when no stage
   * finished or the timing interval is incomplete. */
  efficiencyPct: number | null;
  /** The Scorecard's Unused core time: driver idle plus executor slack as a share of available
   * core time. `100 - unusedCoreTimePct` is what the `--min-efficiency` budget checks. */
  unusedCoreTimePct: number | null;
  /** Summed stage time per ETL phase (a stage can count in more than one), in ms. Null when no
   * stage time is attributable to any phase. */
  etlPhasesMs: { extract: number; transform: number; load: number } | null;
  /** Busy cores at the peak of the Core Usage by Locality chart, or null with no plottable
   * stage activity. */
  peakBusyCores: number | null;
}

export function computeRunShape(appModel: AppModel): RunShape {
  const timed = hasCompleteApplicationInterval(appModel.app);
  const estimates = getScorecardEstimates(appModel);
  const phases = attributeEtlPhases(appModel.stages);
  const chart = buildLocalityChart([...appModel.stages.values()], appModel.app);
  return {
    wallClockMs: timed ? computeWallClock(appModel.app, appModel.stages).total : null,
    efficiencyPct: hasFinishedStage(appModel.stages) ? estimates.efficiency.value : null,
    unusedCoreTimePct: estimates.wastage.value,
    etlPhasesMs: phases.extract + phases.transform + phases.load > 0 ? phases : null,
    peakBusyCores: chart.hasActivity ? chart.peakCores : null,
  };
}
