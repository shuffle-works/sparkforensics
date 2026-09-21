// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { useFindingAnchor, useIsRouteFlash } from '@/view/finding-anchor';
import { TriageNavigationProvider, type TriageNavigation } from '@/view/TriageNavigationContext';

function noop() {
  return () => {};
}

// Stable across re-renders: inline handlers would change the memoized navigation
// bundle's identity and defeat the same-contents-different-reference test below.
const reportWidgetOpen = vi.fn();
const clearRouteFocus = vi.fn();

function skewFinding(stageId = 1): Finding {
  return { type: 'skew', stageId, impactBand: 'warning', recommendation: 'Salt the key.' };
}

function stageShapeFinding(stageId = 1): Finding {
  return { type: 'stageShape', stageId, impactBand: 'info', recommendation: 'Check partition count.' };
}

function AnchorProbe({ findings }: { findings: Finding[] }) {
  const ref = useFindingAnchor(findings);
  const flashed = useIsRouteFlash(findings);
  return (
    <div>
      <div ref={ref} data-testid="anchor" />
      <span data-testid="flashed">{String(flashed)}</span>
    </div>
  );
}

function Harness({
  findings,
  registerFindingAnchor = noop,
  flashedFinding = null,
}: {
  findings: Finding[];
  registerFindingAnchor?: TriageNavigation['registerFindingAnchor'];
  flashedFinding?: Finding | null;
}) {
  return (
    <TriageNavigationProvider
      registerWidget={noop}
      registerFindingAnchor={registerFindingAnchor}
      reportWidgetOpen={reportWidgetOpen}
      clearRouteFocus={clearRouteFocus}
      focusedWidgetId={null}
      activeRouteTarget={null}
      flashedFinding={flashedFinding}
    >
      <AnchorProbe findings={findings} />
    </TriageNavigationProvider>
  );
}

test('registers the mounted element under every finding in the group', () => {
  const registerFindingAnchor = vi.fn(() => vi.fn());
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);

  render(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);

  const element = screen.getByTestId('anchor');
  expect(registerFindingAnchor).toHaveBeenCalledTimes(2);
  expect(registerFindingAnchor).toHaveBeenNthCalledWith(1, f1, element);
  expect(registerFindingAnchor).toHaveBeenNthCalledWith(2, f2, element);
});

test('unregisters every finding on unmount', () => {
  const cleanup1 = vi.fn();
  const cleanup2 = vi.fn();
  const registerFindingAnchor = vi.fn().mockReturnValueOnce(cleanup1).mockReturnValueOnce(cleanup2);
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);

  const { unmount } = render(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);
  expect(cleanup1).not.toHaveBeenCalled();
  expect(cleanup2).not.toHaveBeenCalled();

  unmount();
  expect(cleanup1).toHaveBeenCalledTimes(1);
  expect(cleanup2).toHaveBeenCalledTimes(1);
});

test('a same-contents different-reference findings array does not cause a spurious unregister/re-register', () => {
  const registerFindingAnchor = vi.fn(() => vi.fn());
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);

  const { rerender } = render(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);
  expect(registerFindingAnchor).toHaveBeenCalledTimes(2);

  // Brand-new array wrapper, same finding object references, same signature.
  rerender(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);
  expect(registerFindingAnchor).toHaveBeenCalledTimes(2); // unchanged: no churn

  // Brand-new array AND brand-new finding objects, but same type:stageId signature.
  rerender(<Harness findings={[skewFinding(1), stageShapeFinding(1)]} registerFindingAnchor={registerFindingAnchor} />);
  expect(registerFindingAnchor).toHaveBeenCalledTimes(2); // still unchanged
});

test('re-registers when the set of findings actually changes', () => {
  const cleanups: Array<ReturnType<typeof vi.fn>> = [];
  const registerFindingAnchor = vi.fn(() => {
    const cleanup = vi.fn();
    cleanups.push(cleanup);
    return cleanup;
  });
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);
  const f3 = skewFinding(2); // different stageId -> different signature

  const { rerender } = render(<Harness findings={[f1]} registerFindingAnchor={registerFindingAnchor} />);
  expect(registerFindingAnchor).toHaveBeenCalledTimes(1);

  rerender(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);
  expect(cleanups[0]).toHaveBeenCalledTimes(1); // old single-finding registration torn down
  expect(registerFindingAnchor).toHaveBeenCalledTimes(3); // re-registered for both f1 and f2

  rerender(<Harness findings={[f3]} registerFindingAnchor={registerFindingAnchor} />);
  expect(cleanups[1]).toHaveBeenCalledTimes(1);
  expect(cleanups[2]).toHaveBeenCalledTimes(1);
  expect(registerFindingAnchor).toHaveBeenCalledTimes(4);
});

test('is a no-op when rendered outside a TriageNavigationProvider', () => {
  expect(() => render(<AnchorProbe findings={[skewFinding(1)]} />)).not.toThrow();
  expect(screen.getByTestId('flashed')).toHaveTextContent('false');
});

test('useIsRouteFlash is true when the flashed finding is one of the findings, by reference', () => {
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);
  render(<Harness findings={[f1, f2]} flashedFinding={f2} />);
  expect(screen.getByTestId('flashed')).toHaveTextContent('true');
});

test('useIsRouteFlash is false when there is no active flash', () => {
  render(<Harness findings={[skewFinding(1)]} flashedFinding={null} />);
  expect(screen.getByTestId('flashed')).toHaveTextContent('false');
});

test('useIsRouteFlash is false for a different finding object even with the same type/stageId (reference check)', () => {
  const f1 = skewFinding(1);
  const lookalike = skewFinding(1); // same shape, different identity, not in the group
  render(<Harness findings={[f1]} flashedFinding={lookalike} />);
  expect(screen.getByTestId('flashed')).toHaveTextContent('false');
});
