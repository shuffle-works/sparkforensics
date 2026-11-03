import type { AppModel, Finding } from './types.ts';

/** What a run comparison reads of one run: its model and its findings. */
export type ComparedRun = AppModel & { catalog: Finding[] };

/** A run as the comparison and the budgets read it: the model and both finding lists of an analyzed run. */
export interface ComparedRunInput { appModel: AppModel; catalog: Finding[]; configFindings?: Finding[] }

/** The findings a run is compared and budgeted over: the detector findings and the config audit's. */
export function comparedFindings({ catalog, configFindings = [] }: Pick<ComparedRunInput, 'catalog' | 'configFindings'>): Finding[] {
  return [...catalog, ...configFindings];
}

export function comparedRun(run: ComparedRunInput): ComparedRun {
  return { ...run.appModel, catalog: comparedFindings(run) };
}
