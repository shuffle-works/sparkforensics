// The run verdict: where to start, a short summary, and the top places to look, ranked by
// potential savings (failures first on a failed run). Shared by the dashboard's verdict card and
// the CLI/MCP evidence report, so both paths name the same first step in the same words.
import { DETECTORS } from './detectors.ts';
import { hasFinishedStage, isCleanRun } from './check-coverage.ts';
import { coreFindingActionLabel } from './finding-action-label.ts';
import { FINDING_NAMES } from './finding-names.ts';
import { formatDuration, IMPACT_BAND_ORDER } from './format-utils.ts';
import { impactFigure, savingsMeaning } from './impact-format.ts';
import { isEligible } from './recommendation-rollup.ts';
import { FAILURE_TYPES, quotesReasonOf, summarizeRunOutcome, type RunOutcome } from './run-outcome.ts';
import { getScorecardEstimates, hasCompleteApplicationInterval } from './scorecard-estimates.ts';
import { computeWallClock } from './wall-clock.ts';
import type { AppModel, Finding } from './types.ts';

/** How many next steps the verdict lists before pointing at the full list. */
export const NEXT_STEP_LIMIT = 3;

/** Finding types whose widget sits in the board's reference region (listed after every action
 * widget). The dashboard's registry must agree: tests/view/detector-registry.test.tsx checks it. */
export const REFERENCE_DISPLAY_TYPES: ReadonlySet<string> = new Set([
  'memoryUtilization', 'utilization', 'coreLocality', 'cacheUtilization',
]);

/** `broadcastSizing` never backs a finding; it emits these two types instead. */
const BROADCAST_SIZING_EMITTED_TYPES = ['overBroadcast', 'underBroadcast'];

/** Every emitted finding type in the board's widget display order: action region before
 * reference region, then ascending `DETECTORS` order (lowest order wins for a repeated type).
 * The last tiebreak of the verdict ranking, so the CLI orders ties exactly as the dashboard. */
export const FINDING_DISPLAY_ORDER: readonly string[] = (() => {
  const orderByType = new Map<string, number>();
  for (const detector of DETECTORS) {
    const emitted = detector.type === 'broadcastSizing' ? BROADCAST_SIZING_EMITTED_TYPES : [detector.type];
    for (const type of emitted) {
      const existing = orderByType.get(type);
      if (existing === undefined || detector.order < existing) orderByType.set(type, detector.order);
    }
  }
  const region = (type: string) => (REFERENCE_DISPLAY_TYPES.has(type) ? 1 : 0);
  return [...orderByType.entries()]
    .sort(([a, orderA], [b, orderB]) => region(a) - region(b) || orderA - orderB)
    .map(([type]) => type);
})();

const DISPLAY_INDEX = new Map(FINDING_DISPLAY_ORDER.map((type, index) => [type, index]));

/** A short imperative label for a finding ("Reduce shuffle size"), falling back to the
 * finding type's name, then its raw type. */
export function findingActionLabel(finding: Finding): string {
  return coreFindingActionLabel(finding) ?? FINDING_NAMES[finding.type] ?? finding.type;
}

/** The finding's own recommendation, or its type's name when it has none. */
export function recommendationText(finding: Finding): string {
  const text = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';
  if (text) return text;
  return FINDING_NAMES[finding.type] ?? finding.type;
}

// The high end of the finding's own occupancy-clipped wall-clock estimate, the figure the
// "Potential savings" line leads with. `null` with no quantified time claim
// (resourceOnly/informational basis): such a finding can never win on its own numbers.
function potentialSavingsMs(finding: Finding): number | null {
  return finding.impactEstimate?.wallClock?.high ?? null;
}

/** True for a finding the verdict can route to: a known display type with a recommendation. */
export function isRankable(finding: Finding): boolean {
  const recommendation = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';
  return DISPLAY_INDEX.has(finding.type) && recommendation.length > 0;
}

/** Every rankable finding, best first. Ranked by potential savings: a quantified estimate always
 * outranks an unquantified one; ties (including "neither has one") fall back to impact band,
 * then widget display order, then input order, so an unquantified warning still leads an info. */
export function rankBySavings(findings: Finding[]): Finding[] {
  const candidates = findings
    .map((finding, index) => ({ finding, index }))
    .filter(({ finding }) => isRankable(finding));
  candidates.sort((left, right) => {
    const leftSavings = potentialSavingsMs(left.finding);
    const rightSavings = potentialSavingsMs(right.finding);
    if (leftSavings !== null && rightSavings !== null && leftSavings !== rightSavings) return rightSavings - leftSavings;
    if ((leftSavings !== null) !== (rightSavings !== null)) return leftSavings !== null ? -1 : 1;
    return (
      (IMPACT_BAND_ORDER[left.finding.impactBand] ?? 9) - (IMPACT_BAND_ORDER[right.finding.impactBand] ?? 9)
      || (DISPLAY_INDEX.get(left.finding.type) ?? Number.MAX_SAFE_INTEGER) - (DISPLAY_INDEX.get(right.finding.type) ?? Number.MAX_SAFE_INTEGER)
      || left.index - right.index
    );
  });
  return candidates.map(({ finding }) => finding);
}

/** One place worth a look: the highest-ranked finding at a location, plus the
 * other finding types flagged at that same location. Findings that share a
 * stage usually share one root cause, so they read as one step, not several. */
export interface NextStep {
  key: string;
  lead: Finding;
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

/** Groups every rankable finding by location, ordered by the location's
 * best-ranked finding, so step 1 is always the run's single biggest win. With
 * `failedJobStageIds` (a run whose jobs failed), failure findings rank ahead
 * of every savings figure and lead their location, those at a failed job's
 * stage first: a speed-up is moot until the job finishes. */
export function buildNextSteps(findings: Finding[], { failedJobStageIds }: { failedJobStageIds?: ReadonlySet<number> } = {}): NextStep[] {
  const ranked = rankBySavings(findings);
  // Array.prototype.sort is stable, so savings order holds within each rank.
  const ordered = failedJobStageIds
    ? [...ranked].sort((a, b) => failureRank(a, failedJobStageIds) - failureRank(b, failedJobStageIds))
    : ranked;
  const steps = new Map<string, NextStep>();
  for (const finding of ordered) {
    const { key, stageId } = locationKey(finding);
    const existing = steps.get(key);
    if (!existing) {
      steps.set(key, { key, lead: finding, related: [], stageId });
      continue;
    }
    const seenTypes = new Set([existing.lead.type, ...existing.related.map((f) => f.type)]);
    if (!seenTypes.has(finding.type)) existing.related.push(finding);
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
  return isIdleCapacityFinding(step.lead);
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
  return (idleStep ? reportedIdlePct(idleStep.lead) : null) ?? fallbackPct;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The run facts the verdict's wording depends on, read once. */
export interface RunFacts {
  /** Wall-clock of the whole run, or null with no complete timing interval. */
  runMs: number | null;
  /** Allocated executor capacity that ran no task (`verdictIdlePct`). */
  idlePct: number | null;
  /** The log has no end-of-run record, so it covers only part of the run. */
  incomplete: boolean;
  /** No finding at all, ranked or not, no failed job, and nothing the log
   * lacked to run a check: the only state the verdict calls clean. */
  clean: boolean;
  outcome: RunOutcome;
  /** The log has stages but none recorded an end, so no stage check had
   * anything to measure. */
  noFinishedStages: boolean;
}

function isFailedRun(facts: RunFacts): boolean {
  return facts.outcome.failedJobs > 0;
}

/** The failed-run title: the one thing a newcomer must know before any
 * tuning advice is that the job did not finish. */
function failedTitle({ failedJobs, totalJobs }: RunOutcome): string {
  if (failedJobs < totalJobs) return `${failedJobs} of ${totalJobs} jobs failed in this run`;
  return totalJobs === 1 ? 'This run failed: its job did not finish' : `This run failed: all ${totalJobs} jobs did not finish`;
}

/** An action label as it reads after "Start here:": only its first letter
 * drops to lower case, so a name inside it ("Switch to Kryo") keeps its
 * capital, and a leading acronym ("GC", "OOM") is left alone. */
function lowerFirst(label: string): string {
  if (/^[A-Z]{2}/.test(label)) return label;
  return label.charAt(0).toLowerCase() + label.slice(1);
}

export function verdictTitle(eligible: Finding[], steps: NextStep[], facts: RunFacts): string {
  if (isFailedRun(facts)) return failedTitle(facts.outcome);
  if (eligible.length === 0 && facts.incomplete) return 'This log looks incomplete, so results cover only part of the run';
  if (eligible.length === 0 && facts.noFinishedStages) return 'This log has no finished stages to check';
  if (eligible.length === 0 && !facts.clean) return 'Nothing to fix, but some checks could not run on this log';
  if (eligible.length === 0) return 'No findings to fix right now.';
  // Every real detector writes a recommendation, so an eligible finding with
  // no route is a defensive case: still never call such a run clean.
  if (steps.length === 0) return `${plural(eligible.length, 'finding')} to review`;
  const lead = steps[0];
  if (isIdleCapacityStep(lead) && facts.idlePct != null) return `Start with cluster size: ${facts.idlePct}% of executor capacity sat idle`;
  if (lead.stageId != null) return `Start with Stage ${lead.stageId}`;
  return `Start here: ${lowerFirst(findingActionLabel(lead.lead))}`;
}

/** The run-level summary under the title: how much was found and where, what
 * the first fix is worth, and the run's idle capacity when that is large
 * enough to matter but is not the first step (whose title already says it). */
export function verdictSummary(eligible: Finding[], steps: NextStep[], facts: RunFacts): string[] {
  const sentences: string[] = [];
  const { failedJobs, totalJobs } = facts.outcome;
  if (failedJobs > 0) {
    if (eligible.some((finding) => !FAILURE_TYPES.has(finding.type))) {
      sentences.push('Fix the failure before tuning: the other findings cover only the work that ran.');
    }
  } else if (totalJobs > 0 && !facts.incomplete) {
    sentences.push(totalJobs === 1 ? 'Its one job succeeded.' : `All ${totalJobs} jobs succeeded.`);
  }
  if (eligible.length === 0) {
    if (failedJobs > 0) return sentences;
    if (facts.clean) sentences.push('Every check passed for this run.');
  } else if (steps.length === 0) {
    sentences.push('They are listed by impact under Findings.');
  } else {
    sentences.push(`${plural(eligible.length, 'finding')} in ${plural(steps.length, 'place')}.`);
    const wallClock = steps[0].lead.impactEstimate?.wallClock;
    if (isIdleCapacityStep(steps[0])) {
      sentences.push('A smaller cluster or dynamic allocation would free the idle cores for other jobs.');
    } else if (wallClock && facts.runMs != null) {
      sentences.push(`The first fix could save up to ${formatDuration(wallClock.high)} of this ${formatDuration(facts.runMs)} run.`);
    }
    if (steps.some((step) => step.related.length > 0)) {
      sentences.push('Findings in the same stage usually share one cause, so they are grouped together and their savings overlap rather than add up.');
    }
  }
  if (facts.incomplete) {
    sentences.push('The log has no end-of-run record, so these figures cover only the part of the run it captured.');
  }
  const leadIsIdle = steps.length > 0 && isIdleCapacityStep(steps[0]);
  if (!leadIsIdle && facts.idlePct != null && facts.idlePct >= IDLE_NOTABLE_PCT) {
    sentences.push(
      steps.some(isIdleCapacityStep)
        ? `${facts.idlePct}% of the executor capacity sat idle, so the cluster may be larger than this job needs.`
        : `${facts.idlePct}% of the run's core time went unused, so the cluster may be larger than this job needs.`,
    );
  }
  return sentences;
}

const STACK_TRACE_HINT = 'Open the driver log only if you need the full stack trace.';

/** What the failure step whose reason the verdict quotes tells the reader:
 * the detector's "inspect the driver log for the reason" would send a
 * newcomer looking for something already on screen. The copied text carries
 * the reason itself, since "quoted above" means nothing once pasted. */
export function quotedReasonText(reason: string): { shown: string; copied: string } {
  const sentence = /[.!?]$/.test(reason) ? reason : `${reason}.`;
  return {
    shown: `Spark's recorded reason is quoted above. ${STACK_TRACE_HINT}`,
    copied: `Spark's recorded reason: ${sentence} ${STACK_TRACE_HINT}`,
  };
}

/** One step as pasteable text: the action, what to try, and the savings. */
export function stepCopyText(finding: Finding, recommendation: string, stageId: number | null = null): string {
  const impact = impactFigure(finding);
  const meaning = savingsMeaning(finding);
  const savings = impact && meaning ? `${impact} ${meaning}` : impact;
  const where = stageId != null ? ` in Stage ${stageId}` : '';
  const headline = `${findingActionLabel(finding)}${where}: ${recommendation}`;
  return [/[.!?]$/.test(headline) ? headline : `${headline}.`, savings ? `Potential savings: ${savings}` : null]
    .filter(Boolean)
    .join(' ');
}

/** The whole verdict as a pasteable checklist for a ticket or a message:
 * run, verdict, numbered steps (with their stage), and how many more places
 * the full list holds. */
export function planCopyText(input: {
  runName: string | null;
  title: string;
  steps: { step: NextStep; recommendation: string }[];
  remaining: number;
}): string {
  const lines = [input.runName ? `Spark run ${input.runName}: ${input.title}` : input.title, ''];
  input.steps.forEach(({ step, recommendation }, index) => {
    lines.push(`${index + 1}. ${stepCopyText(step.lead, recommendation, step.stageId)}`);
  });
  if (input.remaining > 0) lines.push('', `${plural(input.remaining, 'more place')} to look at in the full findings list.`);
  return lines.join('\n');
}

/** A step's "What to try" text for copying: Spark's quoted reason when it is this step's own
 * failure, else the finding's recommendation. */
export function stepCopyRecommendation(step: NextStep, outcome: RunOutcome): string {
  return quotesReasonOf(step.lead, outcome) && outcome.reason
    ? quotedReasonText(outcome.reason).copied
    : recommendationText(step.lead);
}

/** Everything the verdict card shows, computed once for a run. `eligible` is what the verdict
 * counts and ranks: the rollup-eligible findings of a known display type. */
export interface RunVerdictModel {
  eligible: Finding[];
  outcome: RunOutcome;
  steps: NextStep[];
  facts: RunFacts;
  title: string;
  summary: string[];
  /** The first NEXT_STEP_LIMIT steps, and how many more places the full list holds. */
  shown: NextStep[];
  remaining: number;
  /** The "Copy next steps" checklist, or null when there is no step to copy. */
  copyText: string | null;
}

export function buildRunVerdict(appModel: AppModel, allFindings: Finding[]): RunVerdictModel {
  const eligible = allFindings.filter((finding) => isEligible(finding) && DISPLAY_INDEX.has(finding.type));
  const outcome = summarizeRunOutcome(appModel.jobs, allFindings);
  const steps = buildNextSteps(eligible, outcome.failedJobs > 0 ? { failedJobStageIds: outcome.failedJobStageIds } : {});
  const facts: RunFacts = {
    runMs: hasCompleteApplicationInterval(appModel.app) ? computeWallClock(appModel.app, appModel.stages).total : null,
    idlePct: verdictIdlePct(steps, getScorecardEstimates(appModel).wastage.value),
    incomplete: allFindings.some((finding) => finding.type === 'incompleteRun'),
    clean: isCleanRun(appModel, allFindings),
    outcome,
    noFinishedStages: !hasFinishedStage(appModel.stages),
  };
  const title = verdictTitle(eligible, steps, facts);
  const shown = steps.slice(0, NEXT_STEP_LIMIT);
  const remaining = steps.length - shown.length;
  const copyText = shown.length > 0
    ? planCopyText({
      runName: appModel.app?.name ?? null,
      title,
      steps: shown.map((step) => ({ step, recommendation: stepCopyRecommendation(step, outcome) })),
      remaining,
    })
    : null;
  return { eligible, outcome, steps, facts, title, summary: verdictSummary(eligible, steps, facts), shown, remaining, copyText };
}
