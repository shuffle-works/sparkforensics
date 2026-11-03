import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { emptyAppModel, store } from '@/store/store';
import { interpretationOf, type InterpretationState } from '@/view/interpretation';
import { runState } from './run';

/** Installs a run built from `catalog` (and `configFindings`) the way the live app does, for a
 * widget rendered on its own with findings passed as props: its savings figures and verdict text
 * come from the run's interpretation, never from the widget itself. Returns the installed
 * interpretation for widgets that take it as a prop. */
export function installInterpretation(
  catalog: Finding[],
  appModel: AppModel = emptyAppModel(),
  configFindings: Finding[] = [],
): InterpretationState {
  const state = runState({ appModel, catalog, configFindings });
  store.setState(state);
  return interpretationOf(state.run);
}
