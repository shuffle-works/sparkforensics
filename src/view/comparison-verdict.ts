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
  rule: string;
  baseCount: number;
  candCount: number;
}

export type ComparisonTone = 'better' | 'worse' | 'same' | 'unknown';

export interface ComparisonVerdictText {
  title: string;
  tone: ComparisonTone;
  sentences: string[];
}

/** A wall-clock change under this share of run A reads as "about the same":
 * run-to-run noise on a shared cluster easily moves a job a percent or two. */
export const SAME_RUN_TIME_SHARE = 0.02;

/** Plain name for a finding category ("Memory and disk spill"), falling back
 * to its tag when the tag has no help entry. */
function categoryName(rule: string): string {
  const tag = typeTag(rule);
  return TAG_HELP[tag]?.expansion ?? tag;
}

/** Net count change per finding rule. Categories are tallied per (rule,
 * impact band), so a rule whose findings moved from critical to warning shows
 * up as both "introduced" and "resolved"; summing across bands keeps the
 * verdict from saying a rule got both more and less frequent. Order follows
 * first appearance, introduced before resolved. */
function netByRule(findings: { introduced: VerdictCategory[]; resolved: VerdictCategory[] }): Map<string, number> {
  const net = new Map<string, number>();
  for (const item of [...findings.introduced, ...findings.resolved]) {
    net.set(item.rule, (net.get(item.rule) ?? 0) + item.candCount - item.baseCount);
  }
  return net;
}

function namesWhere(net: Map<string, number>, keep: (change: number) => boolean): string[] {
  return [...new Set([...net].filter(([, change]) => keep(change)).map(([rule]) => categoryName(rule)))];
}

/** One plain answer to "did run B get better or worse than run A", from the
 * comparison's own whole-run metrics and finding-category tallies: run time
 * first, then which cost metrics moved each way, then which finding
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
    if (Math.abs(share) < SAME_RUN_TIME_SHARE) {
      title = 'Run B took about as long as run A';
      tone = 'same';
    } else {
      const faster = change < 0;
      title = `Run B finished ${formatDuration(Math.abs(change))} ${faster ? 'faster' : 'slower'} than run A (${Math.round(Math.abs(share) * 100)}%)`;
      tone = faster ? 'better' : 'worse';
    }
  }

  const cost = metrics.filter((metric) => metric.key !== 'wallClock' && !NEUTRAL_METRIC_KEYS.has(metric.key));
  const worse = cost.filter((metric) => metric.direction === 'regression').map((metric) => metric.label);
  const better = cost.filter((metric) => metric.direction === 'improvement').map((metric) => metric.label);
  const sentences: string[] = [];
  if (worse.length > 0) sentences.push(`Worse in run B: ${worse.join(', ')}.`);
  if (better.length > 0) sentences.push(`Better in run B: ${better.join(', ')}.`);
  if (worse.length === 0 && better.length === 0) sentences.push('No other measured cost metric changed.');

  const net = netByRule(findings);
  const introduced = namesWhere(net, (change) => change > 0);
  const resolved = namesWhere(net, (change) => change < 0);
  if (introduced.length > 0) sentences.push(`New or more frequent in run B: ${introduced.join(', ')}.`);
  if (resolved.length > 0) sentences.push(`Less frequent in run B: ${resolved.join(', ')}.`);
  return { title, tone, sentences };
}
