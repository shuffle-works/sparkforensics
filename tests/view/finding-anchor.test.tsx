// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { runFindingKeys, useFindingAnchor, useIsRouteFlash } from '@/view/finding-anchor';
import { TriageNavigationProvider, type TriageNavigation } from '@/view/TriageNavigationContext';
import { testFinding } from './_shared/finding';

function noop() {
  return () => {};
}

// Stable across re-renders: inline handlers would change the memoized navigation
// bundle's identity and defeat the same-contents-different-reference test below.
const reportWidgetOpen = vi.fn();
const clearRouteFocus = vi.fn();

function skewFinding(stageId = 1): Finding {
  return testFinding({ type: 'skew', stageId, impactBand: 'warning', recommendation: 'Salt the key.' });
}

function stageShapeFinding(stageId = 1): Finding {
  return testFinding({ type: 'stageShape', stageId, impactBand: 'info', recommendation: 'Check partition count.', rule: 'lowParallelism' });
}

// Module-level so the navigation bundle keeps its identity across re-renders.
const typeAndStageKey: TriageNavigation['findingKey'] = (finding) => `${finding.type}:${finding.stageId}`;

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
  findingKey = typeAndStageKey,
  flashedFinding = null,
}: {
  findings: Finding[];
  registerFindingAnchor?: TriageNavigation['registerFindingAnchor'];
  findingKey?: TriageNavigation['findingKey'];
  flashedFinding?: Finding | null;
}) {
  return (
    <TriageNavigationProvider
      registerWidget={noop}
      registerFindingAnchor={registerFindingAnchor}
      findingKey={findingKey}
      reportWidgetOpen={reportWidgetOpen}
      clearRouteFocus={clearRouteFocus}
      focusedCardKey={null}
      activeRouteTarget={null}
      flashedFinding={flashedFinding}
    >
      <AnchorProbe findings={findings} />
    </TriageNavigationProvider>
  );
}

test('registers the mounted element under the key of every finding in the group', () => {
  const registerFindingAnchor = vi.fn(() => vi.fn());
  const f1 = skewFinding(1);
  const f2 = stageShapeFinding(1);

  render(<Harness findings={[f1, f2]} registerFindingAnchor={registerFindingAnchor} />);

  const element = screen.getByTestId('anchor');
  expect(registerFindingAnchor).toHaveBeenCalledTimes(2);
  expect(registerFindingAnchor).toHaveBeenNthCalledWith(1, 'skew:1', element);
  expect(registerFindingAnchor).toHaveBeenNthCalledWith(2, 'stageShape:1', element);
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

test('re-registers under the new keys when another run gives the same findings different keys', () => {
  const cleanup = vi.fn();
  const registerFindingAnchor = vi.fn(() => cleanup);
  const finding = skewFinding(1);
  const runKey = (run: string): TriageNavigation['findingKey'] => (f) => `${run}|${f.type}:${f.stageId}`;

  const { rerender } = render(<Harness findings={[finding]} findingKey={runKey('a')} registerFindingAnchor={registerFindingAnchor} />);
  const element = screen.getByTestId('anchor');
  expect(registerFindingAnchor).toHaveBeenLastCalledWith('a|skew:1', element);

  // Same type and stage id, new run: the row registers under the new run's key.
  rerender(<Harness findings={[skewFinding(1)]} findingKey={runKey('b')} registerFindingAnchor={registerFindingAnchor} />);
  expect(cleanup).toHaveBeenCalledTimes(1);
  expect(registerFindingAnchor).toHaveBeenLastCalledWith('b|skew:1', element);
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

test('runFindingKeys gives findings that share a core key one key each, and leaves a lone finding its core key', () => {
  const [a, b, lone] = [skewFinding(1), skewFinding(2), stageShapeFinding(3)];
  const keys = runFindingKeys([a, b, lone]);
  expect([keys(a), keys(b), keys(lone)]).toEqual(['skew|skew|stage:#1', 'skew|skew|stage:#2', 'stageShape|lowParallelism|stage:#3']);
  const twin = skewFinding(1);
  const twins = runFindingKeys([a, twin]);
  expect([twins(a), twins(twin)]).toEqual(['skew|skew|stage:#1', 'skew|skew|stage:#1#1']);
  // A finding outside the run's list falls back to the core key.
  expect(twins(skewFinding(9))).toBe('skew|skew|stage:#9');
});
