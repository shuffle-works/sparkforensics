// The DETECTORS list: every detector entry, assembled in render order from detectors/index.ts. Each
// entry is declared in its detector's folder, detectors/<type>/detect.ts, built by the
// define*Detector helper for its scope (detectors/define.ts). The shared types are in
// detectors/types.ts. Only analyzer.ts and detector-catalog.ts import this module by value; every
// other module reaches the entries through detector-catalog.ts and the helpers through the
// detectors/ modules, or imports types from here with `import type`.
import { mergeThresholds } from './detectors/define.ts';
import detectFolders from './detectors/index.ts';
import type { Detector, SkewThresholds } from './detectors/types.ts';
import type { Finding } from './types.ts';

// detectors/index.ts lists the folders in render order (see widget-rendering.md): `order` is a
// display field, and this list's order breaks ties between equal `order` values.
type DetectorEntry = (typeof detectFolders)[number]['detectors'][number];
export const DETECTORS: readonly DetectorEntry[] = detectFolders.flatMap<DetectorEntry>((folder) => folder.detectors);

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

type EntryEmitting<T extends FindingType, D extends DetectorEntry = DetectorEntry> =
  D extends { emits: readonly (infer E)[] } ? (T extends E ? D : never) : never;

/** The `thresholds` of the entry (or entries, for configAudit) that emit finding type `T`. */
export type ThresholdsOf<T extends FindingType> = EntryEmitting<T>['thresholds'];

// `emits` already only names Finding members (Detector.emits); this makes the reverse hold too, so a
// Finding member no detector emits, or a detector whose type has no Finding member, fails to compile.
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type AssertTrue<T extends true> = T;
export type FindingTypesMatchDetectors = AssertTrue<SameUnion<FindingType, Finding['type']>>;
export type EntriesAreDetectors = AssertTrue<[DetectorEntry] extends [Detector] ? true : false>;

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
