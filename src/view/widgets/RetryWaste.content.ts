import { isStated, type ContentCheck } from '@/view/evidence-panel';

/** The line above states the wasted time, so only the Advanced extension remains of a stated row. */
export const retryWasteContent: ContentCheck<'retryWaste'> = ({ findings, stated, density }) => (
  findings.filter((finding) => !isStated(finding, stated) || (density === 'advanced' && Boolean(finding.extended)))
);
