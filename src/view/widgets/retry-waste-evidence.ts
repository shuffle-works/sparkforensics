import type { Finding } from '@sparkforensics/core/types.ts';

/** Whether a retry-waste row renders. The line above states the wasted time, so only the Advanced
 * extension remains. */
export function retryWasteRowShows(finding: Finding, stated: boolean, advanced: boolean): boolean {
  return !stated || (advanced && finding.type === 'retryWaste' && Boolean(finding.extended));
}
