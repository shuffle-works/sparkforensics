import type { FindingSavings } from '@sparkforensics/core/run-interpretation.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useStore, type InterpretationState } from '@/store/store';

// Read-only access to the store's run interpretation (see store.ts). Type-only core imports:
// this module, like every view that uses it, renders conclusions and never computes them.

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
