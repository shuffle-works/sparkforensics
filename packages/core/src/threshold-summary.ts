import { DETECTORS } from './detectors.ts';
import { presentationOf } from './finding-presentation.ts';

/** The clean-check criterion for a finding type, built from the thresholds of the first DETECTORS
 * entry that emits it (configAudit's four entries share one summary). */
export function getThresholdSummary(type: string): string {
  const presentation = presentationOf(type);
  const entry = DETECTORS.find((d) => (d.emits as readonly string[]).includes(type));
  if (!presentation || !entry) return 'criteria not met';
  return presentation.thresholdSummary(entry.thresholds as never);
}
