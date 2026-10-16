import { formatDuration, typeTag } from './format-utils.ts';
import { TAG_HELP } from './finding-tag-help.ts';
import { DEFAULT_NOISE_BAND, isEscalation, NEUTRAL_METRIC_KEYS, type CompareRunsResult } from './run-comparison.ts';
import type { Comparability } from './comparability.ts';

/** The slice of a comparison metric row the verdict reads. */
export interface VerdictMetric {
  key: string;
  label: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
  /** Set by the comparison with the caller's noise band; absent on a hand-built row. */
  withinNoise?: boolean;
}

/** The slice of the comparability block the verdict reads. */
export type VerdictComparability = Pick<Comparability, 'noiseBand' | 'conf' | 'plan' | 'volume' | 'wallClockBridge' | 'capacity'>;

/** The slice of an introduced or resolved finding row the verdict reads. */
export interface VerdictCategory {
  type: string;
  baseCount: number;
  candCount: number;
}

/** The slice of a changed finding row the verdict reads. */
export interface VerdictChange {
  type: string;
  baseImpactBand: string;
  candImpactBand: string;
}

/** How many of a run's ended jobs failed, counted as `summarizeRunOutcome`
 * counts them. */
export interface VerdictJobOutcome {
  failedJobs: number;
  totalJobs: number;
  /** The log has no end-of-run record, so its run time covers only the part
   * of the run it captured. */
  incomplete?: boolean;
}

/** `equivalent`: configuration, plan and output agree, so a time difference is a difference in
 * capacity or scheduling. `mixed`: wall clock and cost moved opposite ways. */
export type ComparisonTone = 'better' | 'worse' | 'same' | 'unknown' | 'equivalent' | 'mixed';

export interface ComparisonVerdictText {
  title: string;
  tone: ComparisonTone;
  sentences: string[];
}

/** A change under this share of the baseline's value reads as "about the same", for
 * run time and cost metrics alike: run-to-run noise on a shared cluster easily
 * moves a job a percent or two. */
export const SAME_CHANGE_SHARE = DEFAULT_NOISE_BAND;

function measured(metric: VerdictMetric): metric is VerdictMetric & { baseline: number; candidate: number } {
  return metric.baseline != null && metric.candidate != null;
}

function movedPastNoise(metric: VerdictMetric & { baseline: number; candidate: number }): boolean {
  if (metric.withinNoise !== undefined) return !metric.withinNoise;
  if (metric.baseline === 0) return metric.candidate !== 0;
  return Math.abs(metric.candidate - metric.baseline) / Math.abs(metric.baseline) >= SAME_CHANGE_SHARE;
}

const percent = (share: number): string => `${Math.round(Math.abs(share) * 100)}%`;
const times = (ratio: number): string => `×${ratio.toFixed(2)}`;

/** The facts a time difference rests on: the factors of the wall-clock bridge that moved past the
 * noise band, each stated for both runs. */
function bridgeReasons(comparability: VerdictComparability): string[] {
  const { wallClockBridge: bridge, noiseBand } = comparability;
  const moved = (ratio: number | null): boolean => ratio != null && Math.abs(ratio - 1) >= noiseBand;
  const reasons: string[] = [];
  const { meanExecutors, taskTime, taskShareOfAllocation: share } = bridge;
  if (moved(meanExecutors.ratio)) reasons.push(`executors averaged ${meanExecutors.baseline!.toFixed(1)} in the baseline and ${meanExecutors.candidate!.toFixed(1)} in the candidate`);
  if (moved(taskTime.ratio)) reasons.push(`task time was ${formatDuration(taskTime.baseline!)} in the baseline and ${formatDuration(taskTime.candidate!)} in the candidate`);
  if (moved(share.ratio)) reasons.push(`task time filled ${percent(share.baseline!)} of allocated core time in the baseline and ${percent(share.candidate!)} in the candidate`);
  return reasons;
}

/** "Wall clock ×1.49 = task time ×0.82 / (mean executors ×0.57 × task share of allocation ×0.96)",
 * candidate over baseline; null when a factor is unmeasured. */
function bridgeSentence({ wallClockBridge: bridge }: VerdictComparability): string | null {
  const { wallClock, taskTime, meanExecutors, taskShareOfAllocation: share } = bridge;
  if (wallClock.ratio == null || taskTime.ratio == null || meanExecutors.ratio == null || share.ratio == null) return null;
  return `Candidate over baseline: wall clock ${times(wallClock.ratio)} is task time ${times(taskTime.ratio)} divided by mean executors ${times(meanExecutors.ratio)} times task time's share of allocated core time ${times(share.ratio)}.`;
}

/** True when configuration, plan and output all agree between the runs. */
function equivalentRuns({ conf, plan, volume }: VerdictComparability): boolean {
  return conf.equal === true && plan.equal && volume.equal === true;
}

/** The cost metrics that moved past noise against the direction wall clock moved, as phrases such
 * as "executor run-time is 18% lower". Empty when wall clock stayed within noise. */
function opposingCost(wall: VerdictMetric & { baseline: number; candidate: number }, metrics: VerdictMetric[]): string[] {
  if (!movedPastNoise(wall)) return [];
  const wallUp = wall.candidate > wall.baseline;
  return metrics
    .filter((m) => m.key === 'executorRunTime' || m.key === 'allocatedCoreHours')
    .filter(measured)
    .filter((m) => m.baseline > 0 && movedPastNoise(m) && (m.candidate > m.baseline) !== wallUp)
    .map((m) => `${m.label.toLowerCase()} is ${percent((m.candidate - m.baseline) / m.baseline)} ${m.candidate < m.baseline ? 'lower' : 'higher'}`);
}

/** Plain name for a finding type ("Memory and disk spill"), falling back to
 * its tag when the tag has no help entry. */
function categoryName(type: string): string {
  const tag = typeTag(type);
  return TAG_HELP[tag]?.expansion ?? tag;
}

/** Net count change per displayed category name. Several rules share one name (every Plan Advisor
 * type reads "Plan advisor", every stage-shape sub-rule "Stage shape"), so two rules under one
 * name moving opposite ways net out rather than read as both "new" and "less frequent". Findings
 * that only changed impact band are not in `introduced` or `resolved`, so they do not move a
 * category. Order follows first appearance, introduced before resolved. */
function netByCategory(findings: { introduced: VerdictCategory[]; resolved: VerdictCategory[] }): Map<string, number> {
  const net = new Map<string, number>();
  for (const item of [...findings.introduced, ...findings.resolved]) {
    const name = categoryName(item.type);
    net.set(name, (net.get(name) ?? 0) + item.candCount - item.baseCount);
  }
  return net;
}

function namesWhere(net: Map<string, number>, keep: (change: number) => boolean): string[] {
  return [...net].filter(([, change]) => keep(change)).map(([name]) => name);
}

/** "The candidate had 2 of 5 jobs fail", or, when every job failed, "The candidate's only
 * job failed" / "All 3 of the candidate's jobs failed" rather than "1 of 1 jobs". */
function jobsFailed(run: 'baseline' | 'candidate', { failedJobs, totalJobs }: VerdictJobOutcome): string {
  if (failedJobs < totalJobs) return `The ${run} had ${failedJobs} of ${totalJobs} jobs fail`;
  return totalJobs === 1 ? `The ${run}'s only job failed` : `All ${totalJobs} of the ${run}'s jobs failed`;
}

/** The baseline's failures in the parenthesis after the candidate's. */
function baselineFailures({ failedJobs, totalJobs }: VerdictJobOutcome): string {
  if (failedJobs === 0) return 'none';
  if (failedJobs < totalJobs) return `${failedJobs} of ${totalJobs}`;
  return totalJobs === 1 ? 'its only job failed' : `all ${totalJobs} failed`;
}

/** The headline when either run had failed jobs, as the run verdict leads
 * with a failure: a faster candidate that dropped work is not an improvement,
 * and with equal failure counts the tone stays neutral since a failing run
 * that ends sooner may just have failed earlier. Null when both runs
 * completed. */
function failureHeadline(base: VerdictJobOutcome, cand: VerdictJobOutcome): { title: string; tone: ComparisonTone } | null {
  if (base.failedJobs === 0 && cand.failedJobs === 0) return null;
  const tone = cand.failedJobs > base.failedJobs ? 'worse' : cand.failedJobs < base.failedJobs ? 'better' : 'same';
  if (cand.failedJobs === 0) return { title: `${jobsFailed('baseline', base)}; the candidate completed`, tone };
  return { title: `${jobsFailed('candidate', cand)} (baseline: ${baselineFailures(base)})`, tone };
}

/** One plain answer to "did the candidate get better or worse than the baseline", from the
 * comparison's own whole-run metrics and finding-category tallies: run time
 * first, then which cost metrics moved each way past run-to-run noise, then which finding
 * categories appeared or went away. When either run had failed jobs, that
 * leads instead and run time becomes the first sentence. When either log is
 * incomplete, run time is stated as what each log covers, never as faster or
 * slower, and the tone stays neutral. Volume and count metrics (input, output,
 * tasks, executors) are left out because more or less of them is not
 * inherently better or worse. With the comparability block, runs whose configuration, plan
 * and output agree read `equivalent` and the title says where a time difference came from, and a
 * wall clock that moved against the cost metrics reads `mixed`; failures and incomplete logs
 * still lead. */
export function summarizeComparison(
  metrics: VerdictMetric[],
  findings: { introduced: VerdictCategory[]; resolved: VerdictCategory[]; changed?: VerdictChange[] },
  jobs?: { baseline: VerdictJobOutcome; candidate: VerdictJobOutcome },
  comparability?: VerdictComparability,
): ComparisonVerdictText {
  const wall = metrics.find((metric) => metric.key === 'wallClock');
  let title = 'Run time could not be compared between the baseline and the candidate';
  let tone: ComparisonTone = 'unknown';
  // A log with no end-of-run record stops where the run was cut off, so its
  // shorter time is not a speed-up: say how much each log covers, neutrally.
  const incompleteRuns = jobs ? (['baseline', 'candidate'] as const).filter((run) => jobs[run].incomplete) : [];
  if (wall && wall.baseline != null && wall.baseline > 0 && wall.candidate != null && incompleteRuns.length > 0) {
    const change = wall.candidate - wall.baseline;
    title = Math.abs(change / wall.baseline) < SAME_CHANGE_SHARE
      ? "The candidate's log covers about as much run time as the baseline's"
      : `The candidate's log covers ${formatDuration(Math.abs(change))} ${change < 0 ? 'less' : 'more'} run time than the baseline's`;
  } else if (wall && wall.baseline != null && wall.baseline > 0 && wall.candidate != null) {
    const change = wall.candidate - wall.baseline;
    const share = change / wall.baseline;
    if (!movedPastNoise({ ...wall, baseline: wall.baseline, candidate: wall.candidate })) {
      title = 'The candidate took about as long as the baseline';
      tone = 'same';
    } else {
      const faster = change < 0;
      title = `The candidate finished ${formatDuration(Math.abs(change))} ${faster ? 'faster' : 'slower'} than the baseline (${Math.round(Math.abs(share) * 100)}%)`;
      tone = faster ? 'better' : 'worse';
    }
  }

  const sentences: string[] = [];
  const failure = jobs ? failureHeadline(jobs.baseline, jobs.candidate) : null;
  if (comparability && !failure && incompleteRuns.length === 0 && wall && measured(wall) && wall.baseline > 0) {
    const change = wall.candidate - wall.baseline;
    const drift = movedPastNoise(wall)
      ? `Time differs by ${formatDuration(Math.abs(change))} (${percent(change / wall.baseline)})`
      : 'The candidate took about as long as the baseline';
    if (equivalentRuns(comparability)) {
      const reasons = movedPastNoise(wall) ? bridgeReasons(comparability) : [];
      title = `Same configuration, plan and output. ${drift}${reasons.length > 0 ? `: ${reasons.join(', ')}` : ''}.`;
      tone = 'equivalent';
      const bridge = movedPastNoise(wall) ? bridgeSentence(comparability) : null;
      if (bridge) sentences.push(bridge);
    } else {
      const opposed = opposingCost(wall, metrics);
      if (opposed.length > 0) {
        title = `The candidate finished ${formatDuration(Math.abs(change))} ${change < 0 ? 'faster' : 'slower'} than the baseline (${percent(change / wall.baseline)}), while ${opposed.join(' and ')}`;
        tone = 'mixed';
      }
    }
  }

  const cost = metrics.filter((metric) => metric.key !== 'wallClock' && !NEUTRAL_METRIC_KEYS.has(metric.key)).filter(measured);
  const moved = cost.filter(movedPastNoise);
  const worse = moved.filter((metric) => metric.direction === 'regression').map((metric) => metric.label);
  const better = moved.filter((metric) => metric.direction === 'improvement').map((metric) => metric.label);
  if (failure) {
    sentences.push(`${title}.`);
    title = failure.title;
    tone = failure.tone;
  }
  if (incompleteRuns.length === 2) {
    sentences.push('Neither log has an end-of-run record, so their times cover only what each log captured, not how long the runs took.');
  } else if (incompleteRuns.length === 1) {
    sentences.push(`The ${incompleteRuns[0]}'s log has no end-of-run record, so its time covers only what the log captured, not how long the run took.`);
  }
  if (worse.length > 0) sentences.push(`Worse in the candidate: ${worse.join(', ')}.`);
  if (better.length > 0) sentences.push(`Better in the candidate: ${better.join(', ')}.`);
  if (cost.length > 0 && worse.length === 0 && better.length === 0) sentences.push('Other measured cost metrics look about the same.');

  const net = netByCategory(findings);
  const introduced = namesWhere(net, (change) => change > 0);
  const resolved = namesWhere(net, (change) => change < 0);
  if (introduced.length > 0) sentences.push(`New or more frequent in the candidate: ${introduced.join(', ')}.`);
  if (resolved.length > 0) sentences.push(`Less frequent in the candidate: ${resolved.join(', ')}.`);
  const escalated = [...new Set((findings.changed ?? []).filter(isEscalation).map((c) => categoryName(c.type)))];
  if (escalated.length > 0) sentences.push(`More severe in the candidate: ${escalated.join(', ')}.`);
  return { title, tone, sentences };
}

/** The comparison verdict for a core comparison result: the one the dashboard's comparison page
 * leads with, and the one the CLI's --baseline report and MCP compare_runs carry. */
export function comparisonVerdict(result: Pick<CompareRunsResult, 'metrics' | 'findings' | 'jobOutcomes'> & { comparability?: VerdictComparability }): ComparisonVerdictText {
  return summarizeComparison(result.metrics, result.findings, result.jobOutcomes, result.comparability);
}
