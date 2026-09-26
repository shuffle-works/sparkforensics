import { formatDuration, typeTag } from '@sparkforensics/core/format-utils.ts';
import { NEUTRAL_METRIC_KEYS } from '@sparkforensics/core/run-comparison.ts';
import { TAG_HELP } from '@/view/finding-tag-help';

/** The slice of a comparison metric row the verdict reads. */
export interface VerdictMetric {
  key: string;
  label: string;
  baseline: number | null;
  candidate: number | null;
  delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
}

/** The slice of a finding-category delta the verdict reads. */
export interface VerdictCategory {
  type: string;
  baseCount: number;
  candCount: number;
}

export type ComparisonTone = 'better' | 'worse' | 'same' | 'unknown';

export interface ComparisonVerdictText {
  title: string;
  tone: ComparisonTone;
  sentences: string[];
}

/** A change under this share of run A's value reads as "about the same", for
 * run time and cost metrics alike: run-to-run noise on a shared cluster easily
 * moves a job a percent or two. */
export const SAME_CHANGE_SHARE = 0.02;

function measured(metric: VerdictMetric): metric is VerdictMetric & { baseline: number; candidate: number } {
  return metric.baseline != null && metric.candidate != null;
}

function movedPastNoise(metric: VerdictMetric & { baseline: number; candidate: number }): boolean {
  if (metric.baseline === 0) return metric.candidate !== 0;
  return Math.abs(metric.candidate - metric.baseline) / Math.abs(metric.baseline) >= SAME_CHANGE_SHARE;
}

/** Plain name for a finding type ("Memory and disk spill"), falling back to
 * its tag when the tag has no help entry. */
function categoryName(type: string): string {
  const tag = typeTag(type);
  return TAG_HELP[tag]?.expansion ?? tag;
}

/** Net count change per displayed category name. Categories are tallied per
 * (rule, impact band), and several rules share one name (every Plan Advisor
 * type reads "Plan advisor", every stage-shape sub-rule "Stage shape"), so a
 * rule whose findings moved from critical to warning, or two rules under one
 * name moving opposite ways, would otherwise
 * read as both "introduced" and "resolved". Order follows first appearance,
 * introduced before resolved. */
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

/** One plain answer to "did run B get better or worse than run A", from the
 * comparison's own whole-run metrics and finding-category tallies: run time
 * first, then which cost metrics moved each way past run-to-run noise, then which finding
 * categories appeared or went away. Volume and count metrics (input, output,
 * tasks, executors) are left out because more or less of them is not
 * inherently better or worse. */
export function summarizeComparison(
  metrics: VerdictMetric[],
  findings: { introduced: VerdictCategory[]; resolved: VerdictCategory[] },
): ComparisonVerdictText {
  const wall = metrics.find((metric) => metric.key === 'wallClock');
  let title = 'Run time could not be compared between run A and run B';
  let tone: ComparisonTone = 'unknown';
  if (wall && wall.baseline != null && wall.baseline > 0 && wall.candidate != null) {
    const change = wall.candidate - wall.baseline;
    const share = change / wall.baseline;
    if (Math.abs(share) < SAME_CHANGE_SHARE) {
      title = 'Run B took about as long as run A';
      tone = 'same';
    } else {
      const faster = change < 0;
      title = `Run B finished ${formatDuration(Math.abs(change))} ${faster ? 'faster' : 'slower'} than run A (${Math.round(Math.abs(share) * 100)}%)`;
      tone = faster ? 'better' : 'worse';
    }
  }

  const cost = metrics.filter((metric) => metric.key !== 'wallClock' && !NEUTRAL_METRIC_KEYS.has(metric.key)).filter(measured);
  const moved = cost.filter(movedPastNoise);
  const worse = moved.filter((metric) => metric.direction === 'regression').map((metric) => metric.label);
  const better = moved.filter((metric) => metric.direction === 'improvement').map((metric) => metric.label);
  const sentences: string[] = [];
  if (worse.length > 0) sentences.push(`Worse in run B: ${worse.join(', ')}.`);
  if (better.length > 0) sentences.push(`Better in run B: ${better.join(', ')}.`);
  if (cost.length > 0 && worse.length === 0 && better.length === 0) sentences.push('Other measured cost metrics look about the same.');

  const net = netByCategory(findings);
  const introduced = namesWhere(net, (change) => change > 0);
  const resolved = namesWhere(net, (change) => change < 0);
  if (introduced.length > 0) sentences.push(`New or more frequent in run B: ${introduced.join(', ')}.`);
  if (resolved.length > 0) sentences.push(`Less frequent in run B: ${resolved.join(', ')}.`);
  return { title, tone, sentences };
}
