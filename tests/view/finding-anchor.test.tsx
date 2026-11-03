// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { Finding } from '@sparkforensics/core/types';
import { emptyAppModel, store } from '@/store/store';
import { BoardLayoutContext } from '@/view/BoardLayoutContext';
import { buildBoardLayout } from '@/view/board-layout';
import { emptySelection } from '@/view/finding-filter';
import { useAnchoredRow } from '@/view/finding-anchor';
import { testFinding } from './_shared/finding';

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  store.getState().resetModel();
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

const skew = testFinding({ type: 'skew', stageId: 1, impactBand: 'warning', recommendation: 'Salt the key.' });
const stageShape = testFinding({ type: 'stageShape', stageId: 1, impactBand: 'info', recommendation: 'Check partition count.', rule: 'lowParallelism' });
const other = testFinding({ type: 'skew', stageId: 2, impactBand: 'warning', recommendation: 'Salt the key.' });

function layoutOf(catalog: Finding[]) {
  return buildBoardLayout({ interpretation: null, appModel: emptyAppModel(), catalog, configFindings: [], selection: emptySelection(), density: 'basic' });
}

function Row({ findings, id }: { findings: Finding[]; id: string }) {
  const anchor = useAnchoredRow(findings);
  return <div ref={anchor.ref} tabIndex={anchor.tabIndex} data-testid={id} data-flashed={anchor.dataFlashed} className={anchor.flashClassName} />;
}

function Board({ catalog }: { catalog: Finding[] }) {
  return (
    <BoardLayoutContext.Provider value={layoutOf(catalog)}>
      <Row findings={[skew, stageShape]} id="grouped" />
      <Row findings={[other]} id="other" />
    </BoardLayoutContext.Provider>
  );
}

const route = (finding: Finding, catalog: Finding[]) => ({ tab: null, openCards: [], cardKey: null, rowKey: layoutOf(catalog).keyOf(finding) });

test('a route to any finding of a row lands on that row and flashes it, and no other', () => {
  const catalog = [skew, stageShape, other];
  render(<Board catalog={catalog} />);
  expect(screen.getByTestId('grouped')).toHaveAttribute('data-flashed', 'false');

  act(() => store.getState().startRoute(route(stageShape, catalog)));

  expect(screen.getByTestId('grouped')).toHaveFocus();
  expect(screen.getByTestId('grouped')).toHaveAttribute('data-flashed', 'true');
  expect(screen.getByTestId('grouped')).toHaveClass('route-flash');
  expect(screen.getByTestId('other')).toHaveAttribute('data-flashed', 'false');
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
});

test('each route lands once: a row that mounts again under the same route does not take focus again', () => {
  const catalog = [skew, stageShape, other];
  const { unmount } = render(<Board catalog={catalog} />);
  act(() => store.getState().startRoute(route(other, catalog)));
  expect(screen.getByTestId('other')).toHaveFocus();
  unmount();

  render(<Board catalog={catalog} />);
  expect(screen.getByTestId('other')).not.toHaveFocus();
});

test('a newer route to the same row lands again', () => {
  const catalog = [skew, stageShape, other];
  render(<Board catalog={catalog} />);
  act(() => store.getState().startRoute(route(other, catalog)));
  screen.getByTestId('other').blur();
  act(() => store.getState().startRoute(route(other, catalog)));
  expect(screen.getByTestId('other')).toHaveFocus();
});

test('a route to a finding mounts the row that lands it in the same commit', () => {
  const catalog = [skew, stageShape, other];
  act(() => store.getState().startRoute(route(other, catalog)));
  render(<Board catalog={catalog} />);
  expect(screen.getByTestId('other')).toHaveFocus();
});

test('a row outside a board is not a landing', () => {
  render(<Row findings={[skew]} id="alone" />);
  act(() => store.getState().startRoute({ tab: null, openCards: [], cardKey: null, rowKey: 'skew|skew|stage:#1' }));
  expect(screen.getByTestId('alone')).not.toHaveFocus();
  expect(screen.getByTestId('alone')).toHaveAttribute('data-flashed', 'false');
});
