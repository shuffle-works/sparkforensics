import { describe, it, expect } from 'vitest';
import {
  boundsOf, fitZoom, readableViewport, viewportShowsAll, pickLayout, visibleShare, readableWidth,
  MIN_READABLE_ZOOM, MIN_TEXT_PX, SMALLEST_NODE_TEXT_PX, MAX_FIT_ZOOM,
} from '../../src/view/plan-graph/readable-fit';

const DESKTOP = { width: 1392, height: 837 };
const PHONE = { width: 342, height: 741 };

describe('MIN_READABLE_ZOOM', () => {
  it('renders the smallest node text at the minimum on-screen size', () => {
    expect(SMALLEST_NODE_TEXT_PX * MIN_READABLE_ZOOM).toBeGreaterThanOrEqual(MIN_TEXT_PX);
  });
});

describe('boundsOf', () => {
  it('returns null for no rectangles', () => {
    expect(boundsOf([])).toBeNull();
  });

  it('spans every rectangle', () => {
    expect(boundsOf([{ x: 10, y: 20, width: 100, height: 50 }, { x: -5, y: 0, width: 10, height: 10 }]))
      .toEqual({ x: -5, y: 0, width: 115, height: 70 });
  });
});

describe('readableViewport', () => {
  // The audit's case: a 7-node chain about 2020 x 230 px wide before zoom, which
  // the previous fit shrank to 0.63 (node text at 6.3 to 7.6 px).
  const wideChain = { x: 0, y: 0, width: 2020, height: 230 };

  it('would shrink a wide chain below the readable zoom if it were fitted to the canvas', () => {
    expect(fitZoom(wideChain, DESKTOP)).toBeLessThan(MIN_READABLE_ZOOM);
  });

  it('holds the readable zoom for a wide chain and anchors it to the start instead of shrinking', () => {
    const vp = readableViewport(wideChain, DESKTOP);
    expect(vp.zoom).toBe(MIN_READABLE_ZOOM);
    // Overflowing axis: starts at the left edge plus padding, so the scans show first.
    expect(vp.x).toBeGreaterThan(0);
    expect(vp.x).toBeLessThanOrEqual(24);
    // Axis that fits: centered.
    const top = vp.y;
    const bottom = DESKTOP.height - (vp.y + wideChain.height * vp.zoom);
    expect(top).toBeCloseTo(bottom, 5);
  });

  it('fits a small plan to the canvas, capped at the maximum zoom', () => {
    const tiny = { x: 0, y: 0, width: 220, height: 90 };
    expect(readableViewport(tiny, DESKTOP).zoom).toBe(MAX_FIT_ZOOM);
    const medium = { x: 0, y: 0, width: 900, height: 400 };
    const vp = readableViewport(medium, DESKTOP);
    expect(vp.zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(vp.zoom).toBeLessThanOrEqual(MAX_FIT_ZOOM);
    expect(viewportShowsAll(medium, vp, DESKTOP)).toBe(true);
  });

  it('accounts for a graph that does not start at the origin', () => {
    const offset = { x: -400, y: -100, width: 300, height: 200 };
    const vp = readableViewport(offset, DESKTOP);
    expect(viewportShowsAll(offset, vp, DESKTOP)).toBe(true);
  });
});

describe('viewportShowsAll', () => {
  it('is false when the graph overflows the canvas at the fitted viewport', () => {
    const wideChain = { x: 0, y: 0, width: 2020, height: 230 };
    expect(viewportShowsAll(wideChain, readableViewport(wideChain, DESKTOP), DESKTOP)).toBe(false);
  });
});

describe('visibleShare', () => {
  it('is 1 for a plan that fits the canvas at a readable zoom', () => {
    expect(visibleShare({ width: 900, height: 400 }, DESKTOP)).toBe(1);
  });

  it('drops with the share of the plan that overflows at the readable zoom', () => {
    const share = visibleShare({ width: 2020, height: 230 }, DESKTOP);
    expect(share).toBeCloseTo((DESKTOP.width - 48) / (2020 * MIN_READABLE_ZOOM), 5);
  });
});

describe('readableWidth', () => {
  it('is the widest content that fits at the readable zoom', () => {
    const width = readableWidth(DESKTOP);
    expect(fitZoom({ width, height: 1 }, DESKTOP)).toBeCloseTo(MIN_READABLE_ZOOM, 5);
  });
});

describe('pickLayout', () => {
  // A 7-stage chain: about 2020 x 230 laid out right-to-left, about 1150 x 600
  // wrapped into two rows, about 300 x 1700 stacked.
  const rl = { name: 'RL', size: { width: 2020, height: 230 } };
  const wrapped = { name: 'wrapped', size: { width: 1150, height: 600 } };
  const bt = { name: 'BT', size: { width: 300, height: 1700 } };

  it('wraps the chain into rows on a landscape canvas, so it fits at a readable zoom', () => {
    const picked = pickLayout([rl, wrapped, bt], DESKTOP);
    expect(picked).toBe(wrapped);
    expect(readableViewport({ x: 0, y: 0, ...picked.size }, DESKTOP).zoom).toBeGreaterThanOrEqual(MIN_READABLE_ZOOM);
    expect(viewportShowsAll({ x: 0, y: 0, ...picked.size }, readableViewport({ x: 0, y: 0, ...picked.size }, DESKTOP), DESKTOP)).toBe(true);
  });

  it('prefers the band to a stack on a landscape canvas when it cannot wrap', () => {
    expect(pickLayout([rl, bt], DESKTOP)).toBe(rl);
  });

  it('stacks the chain on a phone-shaped canvas', () => {
    expect(pickLayout([rl, wrapped, bt], PHONE)).toBe(bt);
  });

  it('among layouts that all fit, picks the one that fits larger', () => {
    const small = { name: 'small', size: { width: 600, height: 300 } };
    const filling = { name: 'filling', size: { width: 1000, height: 600 } };
    expect(pickLayout([filling, small], DESKTOP)).toBe(small);
  });

  it('keeps the earlier candidate on a tie', () => {
    const same = { name: 'same', size: rl.size };
    expect(pickLayout([rl, same], DESKTOP)).toBe(rl);
  });
});
