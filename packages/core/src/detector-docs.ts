// Type-level doc anchors, read off the detector catalog. Kept out of docs-config.ts so the docs
// URL helpers (used by every renderer) don't pull in the detectors themselves.
import { DETECTORS, detectorCatalog } from './detectors.ts';
import { isKnownDocAnchor } from './docs-config.ts';
import { getThresholdSummary } from './threshold-summary.ts';

// Finding types that never appear as their own DETECTORS entry's type: the parent entry declares
// a different type because one plan-walk covers two rules (see broadcastSizing). Map to the parent.
const TYPE_ALIASES: Record<string, string> = {
  overBroadcast: 'broadcastSizing',
  underBroadcast: 'broadcastSizing',
};

// DETECTORS is static, so this grouping is built once (lazily) instead of re-scanning per
// docAnchorForType call (called once per TagBadge per render).
let anchorsByTypeCache: Map<string, Set<string | undefined>> | undefined;

function anchorsByType(): Map<string, Set<string | undefined>> {
  if (!anchorsByTypeCache) {
    anchorsByTypeCache = new Map();
    for (const entry of detectorCatalog()) {
      const anchors = anchorsByTypeCache.get(entry.type) ?? new Set();
      anchors.add(entry.docAnchor);
      anchorsByTypeCache.set(entry.type, anchors);
    }
  }
  return anchorsByTypeCache;
}

/** Resolves a finding `type` to its documented anchor from detectorCatalog(). Returns undefined
 * when entries sharing the type disagree on docAnchor (only configAudit today), or when the
 * resolved anchor isn't in the allowlist (isKnownDocAnchor, the same gate DocsLink uses). */
export function docAnchorForType(type: string): string | undefined {
  const resolvedType = TYPE_ALIASES[type] ?? type;
  const anchors = anchorsByType().get(resolvedType) ?? new Set();
  if (anchors.size !== 1) return undefined;
  const [anchor] = anchors;
  return anchor && isKnownDocAnchor(anchor) ? anchor : undefined;
}

/** What a renderer shows about one finding type without running its detector. */
export interface DetectorInfo {
  /** The lowest `DETECTORS` order among the entries that emit this type. */
  order: number;
  /** `docAnchorForType`, or null when the type has no single known anchor. */
  docAnchor: string | null;
  /** The criterion a clean check was measured against. */
  thresholdSummary: string;
}

/** Every emitted finding type's `DetectorInfo`, in `DETECTORS` declaration order: each
 * `DETECTORS` type, followed by the types it emits under another name (`TYPE_ALIASES`), which
 * take its order. The key order is the widget order's tie-break, so it is part of the result. */
export function detectorInfoByType(): Record<string, DetectorInfo> {
  const orderByType = new Map<string, number>();
  for (const { type, order } of DETECTORS) {
    const aliases = Object.keys(TYPE_ALIASES).filter((alias) => TYPE_ALIASES[alias] === type);
    for (const emitted of [type, ...aliases]) orderByType.set(emitted, Math.min(order, orderByType.get(emitted) ?? Infinity));
  }
  const info: Record<string, DetectorInfo> = {};
  for (const [type, order] of orderByType) {
    info[type] = { order, docAnchor: docAnchorForType(type) ?? null, thresholdSummary: getThresholdSummary(type) };
  }
  return info;
}
