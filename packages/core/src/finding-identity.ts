import type { Finding } from './types.ts';

/** Maps a finding's location in one run to a label shared by both runs. A stage or execution that
 * pairs with one in the other run gets the same label on both sides; one that pairs with nothing
 * gets a label no other run's location can equal. */
export interface FindingLocator {
  stage(stageId: number): string;
  execution(executionId: number): string;
}

/** The finding's rule, or its type when the detector emits no rule. */
export function findingRule(finding: Finding): string {
  return 'rule' in finding && typeof finding.rule === 'string' ? finding.rule : finding.type;
}

/** The finding's band, `unknown` when the impact estimate could not grade it. */
export function findingBand(finding: Finding): string {
  return finding.impactBand ?? 'unknown';
}

/** Where a finding sits in its run: a stage, else a SQL execution, else an audited config property,
 * else the whole run. The one rule both a finding's id within a run and its key across two runs read. */
export type FindingLocation =
  | { scope: 'stage'; stageId: number }
  | { scope: 'execution'; executionId: number }
  | { scope: 'property'; property: string }
  | { scope: 'run' };

export function findingLocation(finding: Finding): FindingLocation {
  if (finding.stageId != null) return { scope: 'stage', stageId: finding.stageId };
  if ('executionId' in finding && typeof finding.executionId === 'number') return { scope: 'execution', executionId: finding.executionId };
  if (finding.type === 'configAudit') return { scope: 'property', property: finding.property };
  return { scope: 'run' };
}

function locationLabel(location: FindingLocation, locator: FindingLocator): string {
  switch (location.scope) {
    case 'stage': return `stage:${locator.stage(location.stageId)}`;
    case 'execution': return `execution:${locator.execution(location.executionId)}`;
    case 'property': return `property:${location.property}`;
    case 'run': return 'run';
  }
}

/** The identity of a finding across two runs: its type, rule and location. Never its value or its
 * impact band, which both move from run to run for the same problem (`findingId` hashes the value,
 * so it matches only within one run). */
export function findingKey(finding: Finding, locator: FindingLocator): string {
  return `${finding.type}|${findingRule(finding)}|${locationLabel(findingLocation(finding), locator)}`;
}

export interface FindingDiff {
  /** In the candidate with no counterpart in the baseline. */
  introduced: Finding[];
  /** In the baseline with no counterpart in the candidate. */
  resolved: Finding[];
  /** Present in both runs with a different impact band. */
  changed: Array<{ baseline: Finding; candidate: Finding }>;
}

function groupByKey(findings: Finding[], locator: FindingLocator): Map<string, Finding[]> {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = findingKey(finding, locator);
    const group = groups.get(key);
    if (group) group.push(finding); else groups.set(key, [finding]);
  }
  return groups;
}

/** Pairs two runs' findings by `findingKey`. A key several findings share (one detector firing per
 * host on one run-level key, say) pairs one-to-one: same band first, then in catalog order, so only
 * a count difference or a band no counterpart shares reads as a change. One diff feeds every
 * comparison consumer: the verdict, the budgets and the dashboard. */
export function diffFindings(
  baseline: Finding[], candidate: Finding[], baselineLocator: FindingLocator, candidateLocator: FindingLocator,
): FindingDiff {
  const base = groupByKey(baseline, baselineLocator), cand = groupByKey(candidate, candidateLocator);
  const diff: FindingDiff = { introduced: [], resolved: [], changed: [] };
  for (const key of new Set([...base.keys(), ...cand.keys()])) {
    const unpairedBase = [...(base.get(key) ?? [])], unpairedCand = [...(cand.get(key) ?? [])];
    for (let i = unpairedBase.length - 1; i >= 0; i--) {
      const j = unpairedCand.findIndex((f) => findingBand(f) === findingBand(unpairedBase[i]));
      if (j < 0) continue;
      unpairedBase.splice(i, 1);
      unpairedCand.splice(j, 1);
    }
    const paired = Math.min(unpairedBase.length, unpairedCand.length);
    for (let i = 0; i < paired; i++) diff.changed.push({ baseline: unpairedBase[i], candidate: unpairedCand[i] });
    diff.resolved.push(...unpairedBase.slice(paired));
    diff.introduced.push(...unpairedCand.slice(paired));
  }
  return diff;
}
