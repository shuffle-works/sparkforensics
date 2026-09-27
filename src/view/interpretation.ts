import { rankedRollup, type RankedRollupGroup } from '@sparkforensics/core/recommendation-rollup.ts';
import type { FindingSavings } from '@sparkforensics/core/run-interpretation.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { useStore, type InterpretationState } from '@/store/store';

// Read-only access to the store's run interpretation (see store.ts). Views render the
// conclusions it carries; the one thing recomputed here is the Findings board under a filter,
// which answers what the viewer selected (see `boardRollup`).

export function useInterpretation(): InterpretationState | null {
  return useStore((s) => s.interpretation);
}

/** The finding an interpretation index points at. */
export function findingAt(state: InterpretationState, index: number): Finding | undefined {
  return state.findings[index];
}

const savingsByFinding = new WeakMap<InterpretationState, Map<Finding, FindingSavings>>();

/** A finding's formatted savings from the interpretation, or null for a finding it does not
 * cover (none loaded yet, or a finding object from outside the interpreted run). */
export function savingsOf(state: InterpretationState | null, finding: Finding): FindingSavings | null {
  if (!state) return null;
  let index = savingsByFinding.get(state);
  if (!index) {
    index = new Map(state.findings.map((f, i) => [f, state.data.savings[i]]));
    savingsByFinding.set(state, index);
  }
  return index.get(finding) ?? null;
}

export function useFindingSavings(finding: Finding): FindingSavings | null {
  return savingsOf(useInterpretation(), finding);
}

/** Findings ordered by the interpretation's potential-savings rank, keeping only those in
 * `findings` (e.g. a filtered subset) and only the rankable ones. */
export function rankedBySavings(state: InterpretationState | null, findings: Finding[]): Finding[] {
  if (!state) return [];
  const wanted = new Set(findings);
  return state.data.savingsRank.map((i) => state.findings[i]).filter((f): f is Finding => f != null && wanted.has(f));
}

/** The findings the Findings board lists (rollup-eligible, with a widget to route to). */
export function eligibleFindings(state: InterpretationState | null): Finding[] {
  if (!state) return [];
  return state.data.rollup.eligibleIndexes.map((i) => state.findings[i]).filter((f): f is Finding => f != null);
}

/** A Findings-board group with its members resolved, representative first. */
export interface BoardGroup extends Omit<RankedRollupGroup, 'members'> {
  key: string;
  findings: Finding[];
}

function boardGroup({ members, ...group }: RankedRollupGroup): BoardGroup {
  return { ...group, key: `${group.kind}-${group.type}-${group.unit ?? ''}`, findings: members };
}

/** The Findings board over `shown` (the findings the active filter keeps). Unfiltered, it is the
 * run's own fix-first list, exactly as the interpretation carries it. Under a filter the groups
 * are recomputed over the eligible findings the filter keeps: a time group's "recoverable" figure
 * caps the summed savings at the union of its members' stage intervals, and that union cannot be
 * re-totalled from the carried per-group figures once members drop out. */
export function boardRollup(
  state: InterpretationState | null,
  shown: Finding[],
  stages: AppModel['stages'],
): { eligible: Finding[]; groups: BoardGroup[] } {
  if (!state) return { eligible: [], groups: [] };
  const kept = new Set(shown);
  const eligible = eligibleFindings(state).filter((finding) => kept.has(finding));
  const unfiltered = state.findings.every((finding) => kept.has(finding));
  const groups = unfiltered
    ? state.data.rollup.groups.map(({ memberIndexes, ...group }) => boardGroup({
      ...group, members: memberIndexes.map((i) => state.findings[i]).filter((f): f is Finding => f != null),
    }))
    : rankedRollup(eligible, stages).map(boardGroup);
  return { eligible, groups };
}
