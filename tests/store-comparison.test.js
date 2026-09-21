import { describe, it, expect, beforeEach } from 'vitest';
import { store, emptyAppModel } from '../src/store/store';

beforeEach(() => {
  store.getState().resetModel();
  // resetModel leaves sessionCache/activeFileId untouched; clear them so the
  // snapshot assertions below start from a known-empty cache.
  store.setState({ sessionCache: new Map(), activeFileId: null });
});

describe('comparison store slice', () => {
  it('defaults to inactive', () => {
    expect(store.getState().comparison).toEqual({ active: false, baselineId: null, candidateId: null });
  });
  it('openComparison activates with the two ids; close deactivates', () => {
    store.getState().openComparison('b-id', 'c-id');
    expect(store.getState().comparison).toEqual({ active: true, baselineId: 'b-id', candidateId: 'c-id' });
    store.getState().closeComparison();
    expect(store.getState().comparison.active).toBe(false);
  });
  it('resetModel exits an active comparison', () => {
    store.getState().openComparison('b-id', 'c-id');
    store.getState().resetModel();
    expect(store.getState().comparison.active).toBe(false);
  });

  it('openComparison snapshots the active run into sessionCache (so a pure render-time read can resolve it)', () => {
    store.setState({
      activeFileId: 'active::1::2',
      appModel: { ...emptyAppModel(), app: { name: 'Active App' } },
      catalog: [{ type: 'gc', impactBand: 'info' }],
    });
    store.getState().openComparison('active::1::2', 'other::3::4');
    const snap = store.getState().sessionCache.get('active::1::2');
    expect(snap?.app).toEqual({ name: 'Active App' });
    expect(snap.catalog).toEqual([{ type: 'gc', impactBand: 'info' }]);
  });

  it('openComparison snapshots nothing when no run is active', () => {
    store.getState().openComparison('a', 'b');
    expect(store.getState().sessionCache.size).toBe(0);
  });

  it('setComparisonActive toggles active without clearing ids (drill-in / back)', () => {
    store.getState().openComparison('b-id', 'c-id');
    store.getState().setComparisonActive(false); // drill into a run
    expect(store.getState().comparison).toEqual({ active: false, baselineId: 'b-id', candidateId: 'c-id' });
    store.getState().setComparisonActive(true); // back to comparison
    expect(store.getState().comparison).toEqual({ active: true, baselineId: 'b-id', candidateId: 'c-id' });
  });

  it('compareLoad defaults to null and setCompareLoad updates it', () => {
    expect(store.getState().compareLoad).toBeNull();
    store.getState().setCompareLoad({ current: 2 });
    expect(store.getState().compareLoad).toEqual({ current: 2 });
    store.getState().setCompareLoad(null);
    expect(store.getState().compareLoad).toBeNull();
  });
});
