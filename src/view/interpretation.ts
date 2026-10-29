import { rankedRollup, type RankedRollupGroup } from '@sparkforensics/core/recommendation-rollup.ts';
import type { AnalyzedRun } from '@sparkforensics/core/analyzed-run.ts';
import type { FindingSavings, RunInterpretation } from '@sparkforensics/core/run-interpretation.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { useStore } from '@/store/store';

// Read-only access to the installed run's interpretation (see store.ts). Views render the
// conclusions it carries; the one thing recomputed here is the Findings board under a filter,
// which answers what the viewer selected (see `boardRollup`).

/** A run's interpretation with the findings its ids point at. */
export interface InterpretationState {
  data: RunInterpretation;
  /** The run's findings, detector findings then configuration findings. */
  findings: Finding[];
  byId: ReadonlyMap<string, Finding>;
}

const interpretationStates = new WeakMap<AnalyzedRun, InterpretationState>();

export function interpretationOf(run: AnalyzedRun): InterpretationState {
  let state = interpretationStates.get(run);
  if (!state) {
    const findings = [...run.catalog, ...run.configFindings];
    const byId = new Map(findings.flatMap((finding): Array<[string, Finding]> => (finding.id == null ? [] : [[finding.id, finding]])));
    state = { data: run.interpretation, findings, byId };
    interpretationStates.set(run, state);
  }
  return state;
}

export function useInterpretation(): InterpretationState | null {
  return useStore((s) => (s.run ? interpretationOf(s.run) : null));
}

/** The finding an interpretation id points at. */
export function findingById(state: InterpretationState, id: string): Finding | undefined {
  return state.byId.get(id);
}

/** A finding's formatted savings from the interpretation, or null for a finding it does not
 * cover (none loaded yet, or a finding from outside the interpreted run). */
export function savingsOf(state: InterpretationState | null, finding: Finding): FindingSavings | null {
  if (!state || finding.id == null) return null;
  return state.data.savings[finding.id] ?? null;
}

export function useFindingSavings(finding: Finding): FindingSavings | null {
  return savingsOf(useInterpretation(), finding);
}

/** Findings ordered by the interpretation's `savingsRank` (stage task time or idle core time, then potential savings), keeping only those in
 * `findings` (e.g. a filtered subset) and only the rankable ones. */
export function rankedBySavings(state: InterpretationState | null, findings: Finding[]): Finding[] {
  if (!state) return [];
  const wanted = new Set(findings);
  return state.data.savingsRank.map((id) => state.byId.get(id)).filter((f): f is Finding => f != null && wanted.has(f));
}

/** The findings the Findings board lists (rollup-eligible, with a widget to route to). */
export function eligibleFindings(state: InterpretationState | null): Finding[] {
  if (!state) return [];
  return state.data.rollup.eligibleIds.map((id) => state.byId.get(id)).filter((f): f is Finding => f != null);
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
    ? state.data.rollup.groups.map(({ memberIds, ...group }) => boardGroup({
      ...group, members: memberIds.map((id) => state.byId.get(id)).filter((f): f is Finding => f != null),
    }))
    : rankedRollup(eligible, stages).map(boardGroup);
  return { eligible, groups };
}

/** Step codes for the verdict's next steps (F1 is the first step), so a step can be found
 * again wherever its lead finding or its stage appears on the board (Findings rows, the
 * stage strip, the Stage Summary table). */
export interface StepCodes {
  byFinding: Map<Finding, string>;
  byStage: Map<number, string>;
}

const EMPTY_STEP_CODES: StepCodes = { byFinding: new Map(), byStage: new Map() };
const stepCodesByState = new WeakMap<InterpretationState, StepCodes>();

export function stepCodes(state: InterpretationState | null): StepCodes {
  if (!state) return EMPTY_STEP_CODES;
  let codes = stepCodesByState.get(state);
  if (!codes) {
    const byFinding = new Map<Finding, string>();
    const byStage = new Map<number, string>();
    state.data.verdict.steps.forEach((step, i) => {
      const code = `F${i + 1}`;
      const lead = state.byId.get(step.leadId);
      if (lead) byFinding.set(lead, code);
      // The first step that names a stage owns its code.
      if (step.stageId != null && !byStage.has(step.stageId)) byStage.set(step.stageId, code);
    });
    codes = { byFinding, byStage };
    stepCodesByState.set(state, codes);
  }
  return codes;
}

export function useStepCodes(): StepCodes {
  return stepCodes(useInterpretation());
}
