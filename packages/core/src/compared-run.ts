import type { AppModel, Finding } from './types.ts';

/** What a run comparison reads of one run: its model and its detector findings. */
export type ComparedRun = AppModel & { catalog: Finding[] };

export function comparedRun({ appModel, catalog }: { appModel: AppModel; catalog: Finding[] }): ComparedRun {
  return { ...appModel, catalog };
}
