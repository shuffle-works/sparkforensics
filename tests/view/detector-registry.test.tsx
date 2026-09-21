// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { DETECTORS } from '@sparkforensics/core/detectors.ts';
import { REGISTRY, orderedWidgets, isAlwaysMountedType, alwaysMountedWidgets } from '../../src/view/detector-registry';

test('every DETECTORS type has a mapped component, except the dead broadcastSizing key', () => {
  // broadcastSizing is a DETECTORS-level type that never backs a real
  // Finding: the detector only ever pushes underBroadcast/overBroadcast (see
  // the next test), so it's excluded here rather than given a REGISTRY entry.
  const missing = DETECTORS.map((d: any) => d.type).filter((t: string) => t !== 'broadcastSizing' && !REGISTRY[t]);
  expect(missing).toEqual([]);
});

// broadcastSizing never emits its own literal type; it pushes
// underBroadcast/overBroadcast, which the DETECTORS-type check above can't catch.
test('the real emitted broadcast-sizing finding types are mapped', () => {
  expect(REGISTRY['underBroadcast']).toBeDefined();
  expect(REGISTRY['overBroadcast']).toBeDefined();
});

test('registry owns stable widget identity and emitted finding copy', () => {
  expect(REGISTRY.skew).toMatchObject({
    widgetId: 'skew', widgetTitle: 'Task Skew', findingLabel: 'task skew', routeable: true,
  });
  expect(REGISTRY.underBroadcast).toMatchObject({
    widgetId: 'under-broadcast', widgetTitle: 'Missed Broadcast Join', findingLabel: 'missed broadcast join', routeable: true,
  });
});

test('every real emitted type has complete stable registry metadata', () => {
  for (const [type, entry] of Object.entries(REGISTRY)) {
    expect(entry.findingLabel, type).toBeTruthy();
    expect(entry.widgetId, type).toBeTruthy();
    expect(entry.widgetTitle, type).toBeTruthy();
    expect(typeof entry.routeable, type).toBe('boolean');
  }
});

test('orderedWidgets never returns the same component twice', () => {
  const comps = orderedWidgets().map((w) => w.component);
  expect(new Set(comps).size).toBe(comps.length);
});

test('ordered widgets retain metadata when active cards are reordered', () => {
  const widgets = orderedWidgets();
  expect(widgets.map((widget) => widget.widgetId)).toContain('spill');
  expect(new Set(widgets.map((widget) => widget.widgetId)).size).toBe(widgets.length);
});

// Every REGISTRY component must be a React.lazy(...) reference (by $$typeof)
// so Vite/Rollup can split each widget into its own chunk.
test('every registry component is code-split via React.lazy', () => {
  for (const [type, entry] of Object.entries(REGISTRY)) {
    expect((entry.component as unknown as { $$typeof?: symbol }).$$typeof, type).toBe(Symbol.for('react.lazy'));
  }
});

test('isAlwaysMountedType flags exactly the one registry type feeding the always-mounted widget', () => {
  expect(isAlwaysMountedType('coreLocality')).toBe(true);
  expect(isAlwaysMountedType('memoryUtilization')).toBe(false);
  expect(isAlwaysMountedType('utilization')).toBe(false);
});

test('isAlwaysMountedType excludes cacheUtilization, memoryUtilization, and utilization despite their reference region (clean runs collapse to a Clean-checks row)', () => {
  expect(REGISTRY.cacheUtilization.region).toBe('reference');
  expect(REGISTRY.memoryUtilization.region).toBe('reference');
  expect(REGISTRY.utilization.region).toBe('reference');
  expect(isAlwaysMountedType('cacheUtilization')).toBe(false);
  expect(isAlwaysMountedType('memoryUtilization')).toBe(false);
  expect(isAlwaysMountedType('utilization')).toBe(false);
});

test('isAlwaysMountedType is false for action-region types and unknown types', () => {
  expect(isAlwaysMountedType('skew')).toBe(false);
  expect(isAlwaysMountedType('duplicatePlanSubtree')).toBe(false);
  expect(isAlwaysMountedType('not-a-real-type')).toBe(false);
});

test('alwaysMountedWidgets returns the one always-mounted reference widget', () => {
  const widgets = alwaysMountedWidgets();
  expect(widgets).toHaveLength(1);
  expect(widgets.map((w) => w.widgetId)).toEqual(['core-usage-area']);
});

test('no always-mounted type shares its component with an action-region (non-always-mounted) type', () => {
  const componentAlwaysMountedFlags = new Map<unknown, Set<boolean>>();
  for (const [type, entry] of Object.entries(REGISTRY)) {
    const flags = componentAlwaysMountedFlags.get(entry.component) ?? new Set<boolean>();
    flags.add(isAlwaysMountedType(type));
    componentAlwaysMountedFlags.set(entry.component, flags);
  }
  for (const flags of componentAlwaysMountedFlags.values()) {
    expect(flags.size).toBe(1);
  }
});
