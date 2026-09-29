// Type-level doc anchors, read off the detector catalog. Kept out of docs-config.ts so the docs
// URL helpers (used by every renderer) don't pull in the detectors themselves.
import { DETECTORS, ENTRY_BY_TYPE } from './detectors.ts';
import { isKnownDocAnchor } from './docs-config.ts';
import { getThresholdSummary } from './threshold-summary.ts';
import type { Detector } from './detectors.ts';

// DETECTORS is static, so this grouping is built once (lazily) instead of re-scanning per
// docAnchorForType call (called once per TagBadge per render). Keyed by emitted finding type, so
// broadcastSizing's anchor lands on underBroadcast/overBroadcast.
let anchorsByTypeCache: Map<string, Set<string | undefined>> | undefined;

function anchorsByType(): Map<string, Set<string | undefined>> {
  if (!anchorsByTypeCache) {
    anchorsByTypeCache = new Map();
    for (const entry of DETECTORS as readonly Detector[]) {
      for (const type of entry.emits) {
        const anchors = anchorsByTypeCache.get(type) ?? new Set();
        anchors.add(entry.docAnchor);
        anchorsByTypeCache.set(type, anchors);
      }
    }
  }
  return anchorsByTypeCache;
}

/** Resolves a finding `type` to its documented anchor from the DETECTORS entries that emit it.
 * Returns undefined when entries sharing the type disagree on docAnchor (only configAudit today),
 * or when the resolved anchor isn't in the allowlist (isKnownDocAnchor, the same gate DocsLink uses). */
export function docAnchorForType(type: string): string | undefined {
  const anchors = anchorsByType().get(type) ?? new Set();
  if (anchors.size !== 1) return undefined;
  const [anchor] = anchors;
  return anchor && isKnownDocAnchor(anchor) ? anchor : undefined;
}

/** What a renderer shows about one finding type without running its detector. */
export interface DetectorInfo {
  /** The order of the type's `ENTRY_BY_TYPE` entry. */
  order: number;
  /** `docAnchorForType`, or null when the type has no single known anchor. */
  docAnchor: string | null;
  /** The criterion a clean check was measured against. */
  thresholdSummary: string;
  /** The type's `ENTRY_BY_TYPE` entry's `scope` (entries sharing a type share one scope). */
  scope: Detector['scope'];
}

/** Every emitted finding type's `DetectorInfo`, in `DETECTORS` declaration order of each entry's
 * `emits` list (a type repeated across entries takes its first position, as `ENTRY_BY_TYPE` does).
 * The key order is the widget order's tie-break, so it is part of the result. */
export function detectorInfoByType(): Record<string, DetectorInfo> {
  const info: Record<string, DetectorInfo> = {};
  for (const [type, { order, scope }] of ENTRY_BY_TYPE) {
    info[type] = { order, docAnchor: docAnchorForType(type) ?? null, thresholdSummary: getThresholdSummary(type), scope };
  }
  return info;
}
