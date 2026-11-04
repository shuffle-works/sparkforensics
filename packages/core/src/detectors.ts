// The DETECTORS list: every detector entry, assembled in render order. Each entry is declared in
// its detector's folder, detectors/<type>/detect.ts, built by the define*Detector helper for its
// scope (detectors/define.ts). The shared types are in detectors/types.ts. Only analyzer.ts and
// detector-catalog.ts import this module by value; every other module reaches the entries through
// detector-catalog.ts and the helpers through the detectors/ modules, or imports types from here
// with `import type`.
import { mergeThresholds } from './detectors/define.ts';
import * as skew from './detectors/skew/detect.ts';
import * as stageShape from './detectors/stage-shape/detect.ts';
import * as shuffle from './detectors/shuffle/detect.ts';
import * as partitionSizing from './detectors/partition-sizing/detect.ts';
import * as spill from './detectors/spill/detect.ts';
import * as gc from './detectors/gc/detect.ts';
import * as slowHost from './detectors/slow-host/detect.ts';
import * as stageSlowness from './detectors/stage-slowness/detect.ts';
import * as stageFailed from './detectors/stage-failed/detect.ts';
import * as failures from './detectors/failures/detect.ts';
import * as straggler from './detectors/straggler/detect.ts';
import * as speculationWaste from './detectors/speculation-waste/detect.ts';
import * as retryWaste from './detectors/retry-waste/detect.ts';
import * as tinyTask from './detectors/tiny-task/detect.ts';
import * as incompleteRun from './detectors/incomplete-run/detect.ts';
import * as coldStart from './detectors/cold-start/detect.ts';
import * as utilization from './detectors/utilization/detect.ts';
import * as rightSizing from './detectors/right-sizing/detect.ts';
import * as memoryUtilization from './detectors/memory-utilization/detect.ts';
import * as cacheUtilization from './detectors/cache-utilization/detect.ts';
import * as coreLocality from './detectors/core-locality/detect.ts';
import * as autoscalingChurn from './detectors/autoscaling-churn/detect.ts';
import * as cachingOpportunity from './detectors/caching-opportunity/detect.ts';
import * as jobFailureRate from './detectors/job-failure-rate/detect.ts';
import * as configAudit from './detectors/config-audit/detect.ts';
import * as duplicatePlanSubtree from './detectors/duplicate-plan-subtree/detect.ts';
import * as smallFiles from './detectors/small-files/detect.ts';
import * as broadcastSizing from './detectors/broadcast-sizing/detect.ts';
import * as pythonUdf from './detectors/python-udf/detect.ts';
import * as nestedLoopJoin from './detectors/nested-loop-join/detect.ts';
import * as mergeRewrite from './detectors/merge-rewrite/detect.ts';
import * as unprunedScan from './detectors/unpruned-scan/detect.ts';
import * as joinKeyCast from './detectors/join-key-cast/detect.ts';
import type { Detector, SkewThresholds } from './detectors/types.ts';
import type { Finding } from './types.ts';

// The order is the render order (see widget-rendering.md): `order` is a display field, and this
// list's declaration order breaks ties between equal `order` values.
export const DETECTORS = [
  ...skew.detectors,
  ...stageShape.detectors,
  ...shuffle.detectors,
  ...partitionSizing.detectors,
  ...spill.detectors,
  ...gc.detectors,
  ...slowHost.detectors,
  ...stageSlowness.detectors,
  ...stageFailed.detectors,
  ...failures.detectors,
  ...straggler.detectors,
  ...speculationWaste.detectors,
  ...retryWaste.detectors,
  ...tinyTask.detectors,
  ...incompleteRun.detectors,
  ...coldStart.detectors,
  ...utilization.detectors,
  ...rightSizing.detectors,
  ...memoryUtilization.detectors,
  ...cacheUtilization.detectors,
  ...coreLocality.detectors,
  ...autoscalingChurn.detectors,
  ...cachingOpportunity.detectors,
  ...jobFailureRate.detectors,
  ...configAudit.detectors,
  ...duplicatePlanSubtree.detectors,
  ...smallFiles.detectors,
  ...broadcastSizing.detectors,
  ...pythonUdf.detectors,
  ...nestedLoopJoin.detectors,
  ...mergeRewrite.detectors,
  ...unprunedScan.detectors,
  ...joinKeyCast.detectors,
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
  // mergeThresholds returns the generic threshold record of the entry.
  // ast-grep-ignore: no-unknown-cast
  return mergeThresholds('skew', ENTRY_BY_TYPE.get('skew')!.thresholds, overrides?.skew ?? {}) as unknown as SkewThresholds;
}
