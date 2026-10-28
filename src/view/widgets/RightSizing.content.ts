import { isStated, type ContentCheck } from '@/view/evidence-panel';

/** The line above states the core counts and both durations; only the Advanced model error remains
 * of a stated row. */
export const rightSizingContent: ContentCheck<'rightSizing'> = ({ findings, stated, density }) => (
  findings.filter((finding) => !isStated(finding, stated) || density === 'advanced')
);
