// The DETECTORS list: every detector entry, assembled in render order. Each entry is declared in
// its family's module under detectors/ (speed-tasks, speed-stages, reliability, cost, plan,
// setup), built by the define*Detector helper for its scope (detectors/define.ts). The shared
// types are in detectors/types.ts. Only analyzer.ts and detector-catalog.ts import this module by
// value; every other module reaches the entries through detector-catalog.ts and the helpers
// through the detectors/ modules, or imports types from here with `import type`.
import { mergeThresholds } from './detectors/define.ts';
import { coldStartDetector, gcDetector, partitionSizingDetector, shuffleDetector, spillDetector, stageShapeDetector, stageSlownessDetector, tinyTaskDetector } from './detectors/speed-stages.ts';
import { skewDetector, slowHostDetector, speculationWasteDetector, stragglerDetector } from './detectors/speed-tasks.ts';
import { failuresDetector, jobFailureRateDetector, retryWasteDetector, stageFailedDetector } from './detectors/reliability.ts';
import {
  autoscalingChurnDetector, cacheUtilizationDetector, cachingOpportunityDetector, coreLocalityDetector, memoryUtilizationDetector,
  rightSizingDetector, utilizationDetector,
} from './detectors/cost.ts';
import {
  broadcastSizingDetector, duplicatePlanSubtreeDetector, joinKeyCastDetector, mergeRewriteDetector, nestedLoopJoinDetector,
  pythonUdfDetector, smallFilesDetector, unprunedScanDetector,
} from './detectors/plan.ts';
import {
  configAuditAutoscaleBoundsDetector, configAuditMemoryOverheadDetector, configAuditSerializerDetector, incompleteRunDetector,
} from './detectors/setup.ts';
import type { Detector, SkewThresholds } from './detectors/types.ts';
import type { Finding } from './types.ts';

// The order is the render order (see widget-rendering.md): `order` is a display field, and this
// list's declaration order breaks ties between equal `order` values.
export const DETECTORS = [
  skewDetector,
  stageShapeDetector,
  shuffleDetector,
  partitionSizingDetector,
  spillDetector,
  gcDetector,
  slowHostDetector,
  stageSlownessDetector,
  stageFailedDetector,
  failuresDetector,
  stragglerDetector,
  speculationWasteDetector,
  retryWasteDetector,
  tinyTaskDetector,
  incompleteRunDetector,
  coldStartDetector,
  utilizationDetector,
  rightSizingDetector,
  memoryUtilizationDetector,
  cacheUtilizationDetector,
  coreLocalityDetector,
  autoscalingChurnDetector,
  cachingOpportunityDetector,
  jobFailureRateDetector,
  configAuditAutoscaleBoundsDetector,
  configAuditSerializerDetector,
  configAuditMemoryOverheadDetector,
  duplicatePlanSubtreeDetector,
  smallFilesDetector,
  broadcastSizingDetector,
  pythonUdfDetector,
  nestedLoopJoinDetector,
  mergeRewriteDetector,
  unprunedScanDetector,
  joinKeyCastDetector,
] as const satisfies readonly Detector[];

/** The entry that emits each finding type: the one whose estimate prices it and whose thresholds
 * and order describe it. Several entries can emit one type (the three configAudit audits), and the
 * first declared wins. */
export const ENTRY_BY_TYPE: ReadonlyMap<string, Detector> = (() => {
  const byType = new Map<string, Detector>();
  for (const entry of DETECTORS as readonly Detector[]) {
    for (const type of entry.emits) if (!byType.has(type)) byType.set(type, entry);
  }
  return byType;
})();

/** A `DETECTORS` entry's own `type`: every emitted finding type, plus broadcastSizing. */
export type DetectorType = (typeof DETECTORS)[number]['type'];

/** Every finding `type` a detector can emit, from the entries' `emits` lists. */
export type FindingType = (typeof DETECTORS)[number]['emits'][number];

type DetectorEntry = (typeof DETECTORS)[number];
type EntryEmitting<T extends FindingType, D extends DetectorEntry = DetectorEntry> =
  D extends { emits: readonly (infer E)[] } ? (T extends E ? D : never) : never;

/** The `thresholds` of the entry (or entries, for configAudit) that emit finding type `T`. */
export type ThresholdsOf<T extends FindingType> = EntryEmitting<T>['thresholds'];

// `emits` already only names Finding members (Detector.emits); this makes the reverse hold too, so a
// Finding member no detector emits, or a detector whose type has no Finding member, fails to compile.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type FindingTypesMatchDetectors = AssertTrue<SameUnion<FindingType, Finding['type']>>;

// A `suppressedBy` that names no entry would never suppress anything; this makes it a compile error.
// An entry without one infers the bare `string` constraint, which contributes nothing here.
type DeclaredSuppressor<D> = D extends { suppressedBy?: infer S } ? (string extends S ? never : S) : never;
type SuppressorType = NonNullable<DeclaredSuppressor<DetectorEntry>>;
export type SuppressorsAreDetectors = AssertTrue<[SuppressorType] extends [DetectorType] ? true : false>;

/** Per-detector threshold overrides, keyed by entry `type`: each value a partial of that entry's
 * own thresholds. Built by threshold-overrides.ts from a user's config file. */
export type ThresholdOverrides = {
  readonly [D in DetectorEntry as D['type']]?: Partial<D['thresholds']>;
};

/** skew's thresholds for a run: its defaults with the user's `skew` overrides merged in. The one
 * resolution analyze() hands to both skew (through withThresholds) and straggler (DetectorCtx). */
export function skewThresholdsFor(overrides: ThresholdOverrides | undefined): SkewThresholds {
  return mergeThresholds('skew', ENTRY_BY_TYPE.get('skew')!.thresholds, overrides?.skew ?? {}) as unknown as SkewThresholds;
}
