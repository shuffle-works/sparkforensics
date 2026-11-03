import type { Finding } from '../types.ts';
import type { BoundDetectSignatures, DefinedDetector, DetectorScope, DetectorSpec, DetectorThresholds } from './types.ts';

// Same-shape overrides merged over the defaults. analyze()'s callers validate overrides at their
// own boundary (threshold-overrides.ts); this re-checks so a programmatic caller can't hand a
// detector a threshold of the wrong shape, which is what makes the cast below sound.
export function mergeThresholds<T extends DetectorThresholds>(type: string, defaults: Readonly<T>, overrides: DetectorThresholds): Readonly<T> {
  for (const [name, value] of Object.entries(overrides)) {
    // Own keys only: an inherited name such as `constructor` or `toString` is no threshold.
    if (!Object.hasOwn(defaults, name)) throw new Error(`Detector ${type} has no threshold "${name}".`);
    const fallback = defaults[name];
    const sameShape = Array.isArray(fallback)
      ? Array.isArray(value) && value.length === fallback.length
      : typeof value === 'number';
    if (!sameShape) throw new Error(`Threshold ${type}.${name} must have the same shape as its default.`);
  }
  return Object.freeze({ ...defaults, ...overrides }) as Readonly<T>;
}

function defineDetector<
  S extends DetectorScope, TType extends string, TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, TSuppressor extends string,
>(
  scope: S, spec: DetectorSpec<S, TType, TEmits, T, TSuppressor>,
  bind: (thresholds: Readonly<T>) => BoundDetectSignatures[S],
): DefinedDetector<S, TType, TEmits, T, TSuppressor> {
  // Frozen: the defaults are the specification, never a knob to mutate in place.
  const defaults = Object.freeze({ ...spec.thresholds }) as Readonly<T>;
  const boundDefaults = bind(defaults);
  return {
    ...spec, scope, thresholds: defaults,
    withThresholds: (overrides) => (overrides && Object.keys(overrides).length > 0
      ? bind(mergeThresholds(spec.type, defaults, overrides))
      : boundDefaults),
  };
}

// One helper per scope: each infers the entry's thresholds type from its `thresholds` literal
// and hands detect() exactly that type, with the scope's target and a required context.
export function defineStageDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'stage', TType, TEmits, T, TSuppressor>) {
  return defineDetector('stage', spec, (t) => (stage, ctx) => spec.detect(stage, ctx, t));
}

export function defineSqlDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'sql', TType, TEmits, T, TSuppressor>) {
  return defineDetector('sql', spec, (t) => (sqlExec, ctx) => spec.detect(sqlExec, ctx, t));
}

export function defineAppDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'app', TType, TEmits, T, TSuppressor>) {
  return defineDetector('app', spec, (t) => (ctx) => spec.detect(ctx, t));
}

export function defineConfigDetector<
  const TType extends string, const TEmits extends readonly Finding['type'][],
  T extends DetectorThresholds, const TSuppressor extends string = never,
>(spec: DetectorSpec<'config', TType, TEmits, T, TSuppressor>) {
  return defineDetector('config', spec, (t) => (target) => spec.detect(target, t));
}
