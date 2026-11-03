// The detector entries as the rest of core reads them. detectors.ts assembles the list; this
// module and analyzer.ts are the only ones that import it by value, so every other module reads
// `DETECTORS` and `ENTRY_BY_TYPE` from here and the HTML export never reaches the entries.
import { DETECTORS, ENTRY_BY_TYPE } from './detectors.ts';
import type { DetectorType } from './detectors.ts';
import type { DetectorScope, DetectorThresholds } from './detectors/types.ts';
import type { TunedThresholds } from './finding-types.ts';

export { DETECTORS, ENTRY_BY_TYPE };

export interface DetectorCatalogEntry {
  type: DetectorType;
  version: number;
  scope: DetectorScope;
  // The thresholds the run used: the entry's own, or with a user's overrides merged in.
  thresholds?: DetectorThresholds;
  docAnchor?: string;
  // Present only when an override moved a threshold off its default (threshold-overrides.ts).
  tunedThresholds?: TunedThresholds;
}

// Machine-readable detector metadata for the evidence report (no `detect` closure), so a
// portable report records which detector + thresholds produced each finding. These are the
// defaults; tunedDetectorCatalog() (threshold-overrides.ts) is the same rows under overrides.
export function detectorCatalog(): DetectorCatalogEntry[] {
  return DETECTORS.map((d) => ({
    type: d.type,
    version: d.version ?? 1,
    scope: d.scope,
    thresholds: d.thresholds,
    docAnchor: d.docAnchor,
  }));
}
