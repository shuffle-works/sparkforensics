// @vitest-environment jsdom
import { isValidElement, type ComponentType } from 'react';
import { test, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Area, Bar, BarChart, CartesianGrid, Line, Scatter, XAxis, YAxis } from 'recharts';

import { ChartFrame, disableSeriesAnimation } from '@/view/charts/ChartTheme';

/** Read `isAnimationActive` off a (possibly transformed) React element. */
function animFlag(node: unknown): boolean | undefined {
  if (!isValidElement<{ isAnimationActive?: boolean }>(node)) return undefined;
  return node.props.isAnimationActive;
}

test('forces isAnimationActive=false on animatable series', () => {
  for (const Series of [Area, Bar, Line, Scatter] as ComponentType<{ dataKey: string }>[]) {
    expect(animFlag(disableSeriesAnimation(<Series dataKey="v" />))).toBe(false);
  }
});

test("leaves a series' explicit isAnimationActive untouched", () => {
  // CoreUsageArea sets its own `false`; a future widget could set `true`.
  expect(animFlag(disableSeriesAnimation(<Bar dataKey="v" isAnimationActive={true} />))).toBe(true);
  expect(animFlag(disableSeriesAnimation(<Area dataKey="v" isAnimationActive={false} />))).toBe(false);
});

test('does not add the flag to non-series elements', () => {
  expect(animFlag(disableSeriesAnimation(<XAxis dataKey="v" />))).toBeUndefined();
  expect(animFlag(disableSeriesAnimation(<CartesianGrid />))).toBeUndefined();
});

test('ChartFrame renders through Recharts with injection active (reduced motion)', () => {
  // jsdom has no matchMedia; stub the reduce preference so ChartFrame takes the injection path.
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  );
  try {
    const { container } = render(
      <ChartFrame ariaLabel="test chart" height={160}>
        <BarChart data={[{ x: 'a', v: 1 }, { x: 'b', v: 2 }]}>
          <CartesianGrid />
          <XAxis dataKey="x" />
          <YAxis />
          <Bar dataKey="v" />
        </BarChart>
      </ChartFrame>,
    );
    // A rendered bar chart yields <path>/<rect> series geometry in the SVG.
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('.recharts-bar-rectangle').length).toBeGreaterThan(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

test('recurses into nested chart children', () => {
  const tree = disableSeriesAnimation(
    <BarChart data={[]}>
      <CartesianGrid />
      <XAxis dataKey="x" />
      <Bar dataKey="a" />
      <Bar dataKey="b" />
    </BarChart>,
  );
  if (!isValidElement<{ children?: unknown }>(tree)) throw new Error('expected an element');
  const children = tree.props.children as unknown[];
  const bars = children.filter((c) => isValidElement(c) && c.type === Bar);
  expect(bars).toHaveLength(2);
  expect(bars.every((b) => animFlag(b) === false)).toBe(true);
  // Axis/grid siblings stay as-is.
  expect(children.filter((c) => animFlag(c) !== undefined)).toHaveLength(2);
});
