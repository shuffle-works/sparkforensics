import { interpretRun } from '@sparkforensics/core/run-interpretation.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { emptyAppModel, store, type InterpretationState } from '@/store/store';

/** Interprets `catalog` (and `configFindings`) the way the live app does and
 * installs the result in the store, for a widget rendered on its own with
 * findings passed as props: its savings figures and verdict text come from the
 * store's interpretation, never from the widget itself. Returns the installed
 * state for widgets that take it as a prop. */
export function installInterpretation(
  catalog: Finding[],
  appModel: AppModel = emptyAppModel(),
  configFindings: Finding[] = [],
): InterpretationState {
  const state = { data: interpretRun(appModel, catalog, configFindings), findings: [...catalog, ...configFindings] };
  store.getState().setInterpretation(state);
  return state;
}
