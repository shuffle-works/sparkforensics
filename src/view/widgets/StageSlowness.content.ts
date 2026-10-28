import { isStated, type ContentCheck } from '@/view/evidence-panel';

/** The line above states the stage duration and the stage, so only the stage's name remains of a
 * stated row. */
export const stageSlownessContent: ContentCheck<'stageSlowness'> = ({ findings, stated, appModel }) => (
  findings.filter((finding) => !isStated(finding, stated) || (finding.stageId != null && Boolean(appModel.stages.get(finding.stageId)?.name)))
);
