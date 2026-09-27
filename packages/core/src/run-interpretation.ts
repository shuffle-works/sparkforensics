// The interpretation layer of a run as plain data: the verdict, which checks could not run and
// why, every finding's formatted savings, and the run-shape figures. Everything here can change
// the conclusion about a run, so it is computed once, by the core that ran the detectors, and
// handed to the renderer as data. The live dashboard (useIngest) and both HTML-export producers
// (html-export.ts) call `interpretRun`; the exported bundle only renders what it carries, so an
// exported file shows the conclusions of the core that wrote it, not of the core that opens it.
import { checkCoverage, hasFinishedStage, verdictGaps } from './check-coverage.ts';
import { computeCoreLocalityRatio } from './core-locality-ratio.ts';
import { buildLocalityChart, type LocalityChart } from './core-usage-locality.ts';
import { detectorInfoByType, type DetectorInfo } from './detector-docs.ts';
import { computeEfficiencyModel } from './efficiency-model.ts';
import { attributeEtlPhases } from './etl-phases.ts';
import { IMPACT_BAND_ORDER, worstImpactBand } from './format-utils.ts';
import {
  estimateProvenance, impactEstimateCompact, impactEstimateFigure, impactFigure, savingsMeaning,
} from './impact-format.ts';
import { isEligible, rankedRollup, type RankedRollupGroup } from './recommendation-rollup.ts';
import { quotesReasonOf } from './run-outcome.ts';
import { computeRunShape, type RunShape } from './run-shape.ts';
import {
  buildNextSteps, buildRunVerdict, FINDING_DISPLAY_ORDER, locationKey, quotedReasonText, rankBySavings, stepCopyText,
} from './run-verdict.ts';
import { recommendationText } from './finding-names.ts';
import { getScorecardEstimates } from './scorecard-estimates.ts';
import { checkConcurrentJobGroups } from './job-groups.ts';
import { computeWallClock } from './wall-clock.ts';
import { computeWastedCoreHours, type WastedCoreHoursResult } from './wasted-core-hours.ts';
import type { AppModel, Finding } from './types.ts';

/** A finding's savings figures, formatted with their units, so a widget shows the figure
 * without formatting it. */
export interface FindingSavings {
  /** The one-line figure the verdict and the findings list lead with: the wall-clock range, or
   * the raw resource figure for a cost-only finding. */
  figure: string | null;
  /** What `figure` counts ("of run time", "of core time"). */
  meaning: string | null;
  /** The widget board's "Potential savings" figure (the range, or raw waste only without one). */
  board: string | null;
  /** High-end-only form for dense lists. */
  compact: string | null;
  /** Advanced view's one-sentence account of how the figure was derived. */
  provenance: string | null;
}

/** One verdict step, fully worded. `leadIndex` names the finding the step routes to. */
export interface InterpretedStep {
  key: string;
  leadIndex: number;
  stageId: number | null;
  /** The other finding types flagged at the same location. */
  relatedTypes: string[];
  /** "What to try": Spark's recorded reason pointer when the step quotes it, else the
   * finding's recommendation. */
  recommendation: string;
  /** The step as pasteable text. */
  copyText: string;
}

export interface RunVerdictData {
  title: string;
  summary: string[];
  failed: boolean;
  clean: boolean;
  /** Spark's recorded failure reason, first line only. */
  failureReason: string | null;
  steps: InterpretedStep[];
  /** How many more places the full findings list holds. */
  remaining: number;
  /** The "Copy next steps" checklist, or null with no step. */
  copyText: string | null;
}

export interface CoverageData {
  noFinishedStages: boolean;
  /** Why each check type could not run, keyed by finding type. A type absent here ran. */
  notRunReasons: Record<string, string>;
  /** The log-wide reasons checks could not run, each naming what to turn on next time. */
  gaps: string[];
}

export type ScorecardFlag = 'critical' | 'warning' | null;

/** The Scorecard's three headline figures (the ones the report's runShape also states) and how
 * each is graded. `wallClockMs` is null without a complete application timing interval. */
export interface RunShapeData extends Pick<RunShape, 'wallClockMs' | 'efficiencyPct' | 'unusedCoreTimePct'> {
  efficiencyFlag: ScorecardFlag;
  unusedCoreTimeFlag: ScorecardFlag;
  unusedCoreTimeUnavailableReason: 'application-timing' | 'core-usage-summary' | 'executor-capacity' | null;
}

export type WallClockData = ReturnType<typeof computeWallClock>;

export type EfficiencyData = ReturnType<typeof computeEfficiencyModel>;

export type EtlPhasesData = ReturnType<typeof attributeEtlPhases>;

export interface CoreLocalityData {
  /** The Core Usage by Locality chart. */
  chart: LocalityChart;
  /** Non-local task share, with every stage's breakdown (no top-N cut). */
  ratio: ReturnType<typeof computeCoreLocalityRatio>;
}

/** A stage's findings as the stage dialog lists them, in the verdict's step order. */
export interface StageFindingsData {
  findingIndexes: number[];
  /** Finding types in "start with the first" order; types the verdict cannot route follow. */
  typeOrder: string[];
}

/** One row group of the Findings board: a finding type (split by impact kind, and by unit for
 * resource figures), its members representative first, the band it sits under, and its trailing
 * figure. */
export interface RollupGroupData extends Omit<RankedRollupGroup, 'members'> {
  /** Members, representative first. */
  memberIndexes: number[];
}

/** The unfiltered Findings board: which findings it lists and its groups in fix-first order. */
export interface RollupData {
  eligibleIndexes: number[];
  groups: RollupGroupData[];
}

/** Findings are referred to by index into the run's findings in catalog-then-config order
 * (`[...catalog, ...configFindings]`), the order both producers pass them in: no copies, so a
 * renderer resolves them to the very objects it already holds. */
export interface RunInterpretation {
  /** Parallel to the findings: each one's formatted savings. */
  savings: FindingSavings[];
  verdict: RunVerdictData;
  coverage: CoverageData;
  runShape: RunShapeData;
  /** How the run's wall-clock time splits across startup, active stages, gaps and idle. */
  wallClock: WallClockData;
  /** Allocated vs. used core-hours. */
  wastedCoreHours: WastedCoreHoursResult;
  /** The driver- vs. executor-bound waste model, or null without run aggregates. */
  efficiency: EfficiencyData | null;
  /** No two job groups overlapped, so wall-clock-based splits and predictions are exact. */
  wallClockReliable: boolean;
  /** Stage time summed by ETL phase. */
  etlPhases: EtlPhasesData;
  coreLocality: CoreLocalityData;
  /** Per finding type: widget order, doc anchor and clean-check criterion. */
  detectors: Record<string, DetectorInfo>;
  /** Every rankable finding's index, best potential savings first. */
  savingsRank: number[];
  /** Keyed by stage id, for stages with at least one finding. */
  stages: Record<string, StageFindingsData>;
  rollup: RollupData;
}

export function findingSavings(finding: Finding): FindingSavings {
  return {
    figure: impactFigure(finding),
    meaning: savingsMeaning(finding),
    board: impactEstimateFigure(finding.impactEstimate)?.text ?? null,
    compact: impactEstimateCompact(finding.impactEstimate),
    provenance: estimateProvenance(finding),
  };
}

// The Scorecard's severity rule: a tile is flagged only when the figure is bad enough to act on.
function efficiencyFlag(pct: number | null): ScorecardFlag {
  if (pct == null) return null;
  return pct < 75 ? 'critical' : pct < 90 ? 'warning' : null;
}

function unusedCoreTimeFlag(pct: number | null): ScorecardFlag {
  if (pct == null) return null;
  return pct >= 70 ? 'critical' : pct >= 40 ? 'warning' : null;
}

function interpretRunShape(appModel: AppModel): RunShapeData {
  const { wallClockMs, efficiencyPct, unusedCoreTimePct } = computeRunShape(appModel);
  const estimates = getScorecardEstimates(appModel);
  return {
    wallClockMs,
    efficiencyPct,
    unusedCoreTimePct,
    efficiencyFlag: efficiencyFlag(efficiencyPct),
    unusedCoreTimeFlag: unusedCoreTimeFlag(unusedCoreTimePct),
    unusedCoreTimeUnavailableReason: estimates.wastage.unavailableReason,
  };
}

function interpretEfficiency(appModel: AppModel): EfficiencyData | null {
  if (!appModel.runAggregates) return null;
  return computeEfficiencyModel({
    app: appModel.app,
    stages: appModel.stages,
    executorsAdded: appModel.executors.added,
    runAggregates: appModel.runAggregates,
  });
}

function interpretCoverage(appModel: AppModel, allFindings: Finding[]): CoverageData {
  const noFinishedStages = !hasFinishedStage(appModel.stages);
  const { notRunReason } = checkCoverage(appModel.stages, allFindings);
  const notRunReasons: Record<string, string> = {};
  for (const type of FINDING_DISPLAY_ORDER) {
    const reason = notRunReason(type);
    if (reason != null) notRunReasons[type] = reason;
  }
  return { noFinishedStages, notRunReasons, gaps: verdictGaps(allFindings, noFinishedStages) };
}

// The stage dialog's grouping: the verdict's location rule (a sql-scope finding touching only
// this stage counts), ordered by the stage's own verdict step, then by worst band.
function interpretStages(
  catalog: Finding[], indexOf: Map<Finding, number>, failedJobStageIds: ReadonlySet<number> | null,
): Record<string, StageFindingsData> {
  const byStage = new Map<number, Finding[]>();
  for (const finding of catalog) {
    const { stageId } = locationKey(finding);
    if (stageId == null) continue;
    const list = byStage.get(stageId) ?? [];
    list.push(finding);
    byStage.set(stageId, list);
  }
  const stages: Record<string, StageFindingsData> = {};
  for (const [stageId, findings] of byStage) {
    const [step] = buildNextSteps(findings, failedJobStageIds ? { failedJobStageIds } : {});
    const stepTypes = step ? [step.lead.type, ...step.related.map((f) => f.type)] : [];
    const worstBand = (type: string) => IMPACT_BAND_ORDER[worstImpactBand(findings.filter((f) => f.type === type))!];
    const otherTypes = [...new Set(findings.map((f) => f.type))]
      .filter((type) => !stepTypes.includes(type))
      .sort((a, b) => worstBand(a) - worstBand(b));
    stages[String(stageId)] = { findingIndexes: findings.map((f) => indexOf.get(f)!), typeOrder: [...stepTypes, ...otherTypes] };
  }
  return stages;
}

const DISPLAY_TYPES: ReadonlySet<string> = new Set(FINDING_DISPLAY_ORDER);

/** Every conclusion the dashboard shows about a run whose detectors already ran. */
export function interpretRun(appModel: AppModel, catalog: Finding[], configFindings: Finding[]): RunInterpretation {
  const allFindings = [...catalog, ...configFindings];
  const indexOf = new Map(allFindings.map((finding, index) => [finding, index]));
  const verdict = buildRunVerdict(appModel, allFindings);
  const { outcome } = verdict;
  const failed = outcome.failedJobs > 0;
  // A board row needs a widget to route to, and every display type has one.
  const eligible = allFindings.filter((finding) => isEligible(finding) && DISPLAY_TYPES.has(finding.type));
  const steps: InterpretedStep[] = verdict.shown.map((step) => {
    const quoted = quotesReasonOf(step.lead, outcome) && outcome.reason ? quotedReasonText(outcome.reason) : null;
    return {
      key: step.key,
      leadIndex: indexOf.get(step.lead)!,
      stageId: step.stageId,
      relatedTypes: step.related.map((f) => f.type),
      recommendation: quoted?.shown ?? recommendationText(step.lead),
      copyText: stepCopyText(step.lead, quoted?.copied ?? recommendationText(step.lead)),
    };
  });
  return {
    savings: allFindings.map(findingSavings),
    verdict: {
      title: verdict.title,
      summary: verdict.summary,
      failed,
      clean: verdict.facts.clean,
      failureReason: outcome.reason,
      steps,
      remaining: verdict.remaining,
      copyText: verdict.copyText,
    },
    coverage: interpretCoverage(appModel, allFindings),
    runShape: interpretRunShape(appModel),
    wallClock: computeWallClock(appModel.app, appModel.stages),
    wastedCoreHours: computeWastedCoreHours(appModel.app, appModel.executors.added, appModel.runAggregates),
    efficiency: interpretEfficiency(appModel),
    wallClockReliable: checkConcurrentJobGroups(appModel.jobs).wallClockReliable,
    etlPhases: attributeEtlPhases(appModel.stages),
    coreLocality: {
      chart: buildLocalityChart([...appModel.stages.values()], appModel.app),
      ratio: computeCoreLocalityRatio([...appModel.stages.values()], { topN: Infinity }),
    },
    detectors: detectorInfoByType(),
    savingsRank: rankBySavings(allFindings).map((finding) => indexOf.get(finding)!),
    stages: interpretStages(catalog, indexOf, failed ? outcome.failedJobStageIds : null),
    rollup: {
      eligibleIndexes: eligible.map((finding) => indexOf.get(finding)!),
      groups: rankedRollup(eligible, appModel.stages)
        .map(({ members, ...group }) => ({ ...group, memberIndexes: members.map((finding) => indexOf.get(finding)!) })),
    },
  };
}
