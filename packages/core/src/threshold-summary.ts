import { DETECTORS, type Detector, type ThresholdOverrides } from './detectors.ts';
import { presentationOf } from './finding-presentation.ts';
import { effectiveThresholds } from './threshold-overrides.ts';

/** The clean-check criterion for a finding type, built from the thresholds of the first DETECTORS
 * entry that emits it (configAudit's four entries share one summary), with `overrides` merged in
 * when the run was tuned. */
export function getThresholdSummary(type: string, overrides?: ThresholdOverrides): string {
  const presentation = presentationOf(type);
  const entry: Detector | undefined = DETECTORS.find((d) => (d.emits as readonly string[]).includes(type));
  if (!presentation || !entry) return 'criteria not met';
  return presentation.thresholdSummary(effectiveThresholds(entry, overrides) as never);
}
