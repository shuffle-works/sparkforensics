import type { DetectorType, Finding, FindingType } from './types.ts';

// Canonical detector `type` -> human-readable label (single source of truth). detector-registry
// imports this (web uses it lowercase); evidence-report.ts Title Cases it for CLI/MCP names.
//
// broadcastSizing is the DETECTORS-level type but no real Finding carries it (the detector pushes
// underBroadcast/overBroadcast). Kept as a dead key so the DETECTORS-type completeness check finds it.
//
// `satisfies` makes the compiler require exactly one entry per finding and detector type; the
// declared type stays string-indexed because Finding.type is still a plain string.
export const FINDING_NAMES: Readonly<Record<string, string>> = {
  incompleteRun: 'incomplete run',

  skew: 'task skew',
  stageShape: 'stage shape',
  tinyTask: 'tiny tasks',

  shuffle: 'shuffle I/O',
  partitionSizing: 'partition sizing',

  spill: 'spill',

  gc: 'GC pressure',

  stageFailed: 'failed stage',
  failures: 'failed tasks',
  retryWaste: 'retry waste',

  slowHost: 'slow executor host',
  stageSlowness: 'slow stage',
  straggler: 'straggling task',
  speculationWaste: 'speculation waste',
  coldStart: 'cold start',

  memoryUtilization: 'memory utilization',
  utilization: 'executor utilization',
  coreLocality: 'core locality',
  cachingOpportunity: 'caching opportunity',
  cacheUtilization: 'cache utilization',
  jobFailureRate: 'job failure rate',
  autoscalingChurn: 'autoscaling churn',

  configAudit: 'config audit',

  duplicatePlanSubtree: 'duplicate plan subtree',
  smallFiles: 'small files',
  broadcastSizing: 'broadcast sizing',
  underBroadcast: 'missed broadcast join',
  overBroadcast: 'oversized broadcast join',
} satisfies Record<FindingType | DetectorType, string>;

// Capitalizes the first letter of each word, leaving other characters untouched so acronyms
// ('GC', 'I/O') survive.
export function titleCase(label: string): string {
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The finding's own recommendation, or its type's name when it has none. */
export function recommendationText(finding: Finding): string {
  const text = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';
  if (text) return text;
  return FINDING_NAMES[finding.type] ?? finding.type;
}
