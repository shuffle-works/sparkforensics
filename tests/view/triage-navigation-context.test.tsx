// Unit tests for the routing context plumbing itself (registration,
// split-for-stability contexts). Integration-level routing behavior lives in
// triage-navigation.test.tsx.
// @vitest-environment jsdom
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import type { TriageTarget } from '@/view/triage-target';
import {
  TriageNavigationProvider,
  useActiveRouteTarget,
  useRouteFlashedFinding,
  useRouteFocusedWidgetId,
  useTriageNavigation,
  type TriageNavigation,
} from '@/view/TriageNavigationContext';

function spillFinding(): Finding {
  return { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'Review spill.' };
}

function spillTarget(finding: Finding): TriageTarget {
  return {
    finding,
    widgetId: 'spill',
    region: 'action',
    findingLabel: 'Spill',
    stageId: 1,
    recommendation: 'Review spill.',
  };
}

function noop() {
  return () => {};
}

function Probe({ capture }: { capture: (navigation: TriageNavigation | null) => void }) {
  const navigation = useTriageNavigation();
  const focusedWidgetId = useRouteFocusedWidgetId();
  const activeRouteTarget = useActiveRouteTarget();
  const flashedFinding = useRouteFlashedFinding();
  capture(navigation);

  return (
    <div>
      <span data-testid="focused">{focusedWidgetId ?? 'none'}</span>
      <span data-testid="target">{activeRouteTarget?.widgetId ?? 'none'}</span>
      <span data-testid="flashed">{flashedFinding?.type ?? 'none'}</span>
    </div>
  );
}

test('threads focusedWidgetId, activeRouteTarget, and flashedFinding through their own hooks', () => {
  const finding = spillFinding();
  const target = spillTarget(finding);
  const capture = vi.fn();

  render(
    <TriageNavigationProvider
      registerWidget={noop}
      registerFindingAnchor={noop}
      reportWidgetOpen={vi.fn()}
      clearRouteFocus={vi.fn()}
      focusedWidgetId="spill"
      activeRouteTarget={target}
      flashedFinding={finding}
    >
      <Probe capture={capture} />
    </TriageNavigationProvider>,
  );

  expect(screen.getByTestId('focused')).toHaveTextContent('spill');
  expect(screen.getByTestId('target')).toHaveTextContent('spill');
  expect(screen.getByTestId('flashed')).toHaveTextContent('spill');
});

test('exposes registerFindingAnchor on the navigation bundle, forwarding args and the returned cleanup', () => {
  const finding = spillFinding();
  const element = document.createElement('div');
  const cleanup = vi.fn();
  const registerFindingAnchor = vi.fn(() => cleanup);
  const capture = vi.fn();

  render(
    <TriageNavigationProvider
      registerWidget={noop}
      registerFindingAnchor={registerFindingAnchor}
      reportWidgetOpen={vi.fn()}
      clearRouteFocus={vi.fn()}
      focusedWidgetId={null}
      activeRouteTarget={null}
      flashedFinding={null}
    >
      <Probe capture={capture} />
    </TriageNavigationProvider>,
  );

  const navigation = capture.mock.calls.at(-1)?.[0] as TriageNavigation;
  const unregister = navigation.registerFindingAnchor(finding, element);
  expect(registerFindingAnchor).toHaveBeenCalledWith(finding, element);

  unregister();
  expect(cleanup).toHaveBeenCalledTimes(1);
});

test('the stable navigation bundle keeps its identity when only focus/target/flash change', async () => {
  const user = userEvent.setup();
  const capture = vi.fn();
  // Stable across re-renders (mirrors a caller's useCallback'd handlers); if
  // re-created each render, the memoized bundle would change identity too and
  // the stability assertion below wouldn't isolate the split-for-stability contract.
  const reportWidgetOpen = vi.fn();
  const clearRouteFocus = vi.fn();

  function Harness() {
    const [focusedWidgetId, setFocusedWidgetId] = useState<string | null>(null);
    return (
      <TriageNavigationProvider
        registerWidget={noop}
        registerFindingAnchor={noop}
        reportWidgetOpen={reportWidgetOpen}
        clearRouteFocus={clearRouteFocus}
        focusedWidgetId={focusedWidgetId}
        activeRouteTarget={null}
        flashedFinding={null}
      >
        <button onClick={() => setFocusedWidgetId('spill')}>focus-spill</button>
        <Probe capture={capture} />
      </TriageNavigationProvider>
    );
  }

  render(<Harness />);
  const navigationBefore = capture.mock.calls.at(-1)?.[0];

  await user.click(screen.getByText('focus-spill'));

  const navigationAfter = capture.mock.calls.at(-1)?.[0];
  expect(screen.getByTestId('focused')).toHaveTextContent('spill');
  expect(navigationAfter).toBe(navigationBefore);
});
