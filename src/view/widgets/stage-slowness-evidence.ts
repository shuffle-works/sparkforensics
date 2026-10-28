import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

/** Whether a slow-stage row renders. The line above states the stage duration and the stage, so
 * only the stage's name is left. */
export function stageSlownessRowShows(finding: Finding, stated: boolean, stages: AppModel['stages']): boolean {
  return !stated || (finding.stageId != null && Boolean(stages.get(finding.stageId)?.name));
}
