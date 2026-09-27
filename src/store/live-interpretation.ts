import { interpretRun } from '@sparkforensics/core/run-interpretation.ts';
import { store, type State } from '@/store/store';

// The live app's producer of the store's `interpretation`: whenever the run model or its
// findings change, interpret them again with the same core function the HTML export uses
// (html-export.ts), so the dashboard and an exported file render the same conclusions.
// Installed by the live entry (main.tsx) only: the export bundle never imports this module and
// renders the interpretation its payload carries instead.

function interpretationInputsChanged(next: State, previous: State): boolean {
  return next.appModel !== previous.appModel
    || next.catalog !== previous.catalog
    || next.configFindings !== previous.configFindings;
}

function interpret(state: State): void {
  if (state.exportMode) return;
  const { appModel, catalog, configFindings } = state;
  store.getState().setInterpretation({
    data: interpretRun(appModel, catalog, configFindings),
    findings: [...catalog, ...configFindings],
  });
}

/** Keeps the store's interpretation in step with its findings. Returns the unsubscribe. */
export function installLiveInterpretation(): () => void {
  interpret(store.getState());
  return store.subscribe((next, previous) => {
    if (interpretationInputsChanged(next, previous)) interpret(next);
  });
}
