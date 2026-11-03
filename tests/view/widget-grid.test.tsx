// @vitest-environment jsdom
import { beforeEach, expect, test } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { store } from '@/store/store';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';
import { useCardStateKey, useWidgetState } from '@/view/useWidgetState';
import { BoardWithCards } from './_shared/board';

beforeEach(() => store.getState().resetModel());

function TestCard({
  cardId,
  title,
  defaultCollapsed = true,
  collapsedTile = false,
}: {
  cardId: string;
  title: string;
  defaultCollapsed?: boolean;
  collapsedTile?: boolean;
}) {
  return (
    <WidgetGridItem cardId={cardId} collapsedTile={collapsedTile}>
      <WidgetCard title={title} defaultCollapsed={defaultCollapsed}>
        <p>{title} details</p>
      </WidgetCard>
    </WidgetGridItem>
  );
}

test('grid cards expand, span, and collapse independently', async () => {
  const user = userEvent.setup();

  render(
    <BoardWithCards keys={['first', 'second']}>
      <WidgetGrid>
        <TestCard cardId="first" title="First" />
        <TestCard cardId="second" title="Second" />
      </WidgetGrid>
    </BoardWithCards>,
  );

  const first = screen.getByTestId('widget-grid-item-first');
  const second = screen.getByTestId('widget-grid-item-second');
  await user.click(screen.getByRole('button', { name: 'First' }));
  await user.click(screen.getByRole('button', { name: 'Second' }));

  expect(first).toHaveClass('col-span-full');
  expect(second).toHaveClass('col-span-full');
  expect(screen.getByText('First details')).toBeVisible();
  expect(screen.getByText('Second details')).toBeVisible();

  await user.click(screen.getByRole('button', { name: 'First' }));

  expect(first).not.toHaveClass('col-span-full');
  expect(screen.queryByText('First details')).not.toBeInTheDocument();
  expect(second).toHaveClass('col-span-full');
  expect(screen.getByText('Second details')).toBeVisible();
});

test('an open grid card spans and can be collapsed', async () => {
  const user = userEvent.setup();

  act(() => store.getState().setCardOpen('available', true));
  render(
    <BoardWithCards keys={['available']}>
      <WidgetGrid>
        <TestCard cardId="available" title="Available" defaultCollapsed={false} />
      </WidgetGrid>
    </BoardWithCards>,
  );

  const item = screen.getByTestId('widget-grid-item-available');
  expect(screen.getByText('Available details')).toBeVisible();
  expect(item).toHaveClass('col-span-full');

  await user.click(screen.getByRole('button', { name: 'Available' }));

  expect(screen.queryByText('Available details')).not.toBeInTheDocument();
  expect(item).not.toHaveClass('col-span-full');
});

test('a collapsedTile grid item starts collapsed and floors its height regardless of defaultCollapsed', async () => {
  const user = userEvent.setup();

  render(
    <BoardWithCards keys={['reference']}>
      <WidgetGrid>
        <TestCard cardId="reference" title="Reference" defaultCollapsed={false} collapsedTile />
      </WidgetGrid>
    </BoardWithCards>,
  );

  // `collapsedTile` overrides the card's own `defaultCollapsed={false}`: it
  // still starts collapsed so every reference-region tile lines up.
  expect(screen.queryByText('Reference details')).not.toBeInTheDocument();
  const card = screen.getByRole('heading', { name: 'Reference' }).closest('[data-slot="card"]');
  expect(card).toHaveClass('min-h-[6.5rem]');

  await user.click(screen.getByRole('button', { name: 'Reference' }));

  expect(screen.getByText('Reference details')).toBeVisible();
  expect(card).not.toHaveClass('min-h-[6.5rem]');
});

test('a collapsed board card mounts no body, and what its widget remembers survives collapsing', async () => {
  const user = userEvent.setup();
  function PagedBody() {
    const [page, setPage] = useWidgetState(useCardStateKey('page'), 0);
    return <button onClick={() => setPage(page + 1)}>{`page ${page}`}</button>;
  }
  render(
    <BoardWithCards keys={['paged']}>
      <WidgetGrid>
        <WidgetGridItem cardId="paged">
          <WidgetCard title="Paged" defaultCollapsed><PagedBody /></WidgetCard>
        </WidgetGridItem>
      </WidgetGrid>
    </BoardWithCards>,
  );
  expect(screen.queryByRole('button', { name: /^page/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Paged' }));
  await user.click(screen.getByRole('button', { name: 'page 0' }));
  expect(screen.getByRole('button', { name: 'page 1' })).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Paged' }));
  expect(screen.queryByRole('button', { name: /^page/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Paged' }));
  expect(screen.getByRole('button', { name: 'page 1' })).toBeInTheDocument();
});

test('a card on its own keeps its collapsed body mounted, hidden', () => {
  render(<WidgetCard title="Alone" defaultCollapsed>alone details</WidgetCard>);
  expect(screen.getByText('alone details')).not.toBeVisible();
});

test('a route that opens a card expands and spans it', () => {
  render(
    <BoardWithCards keys={['test']}>
      <WidgetGrid>
        <TestCard cardId="test" title="Spill" />
      </WidgetGrid>
    </BoardWithCards>,
  );
  expect(screen.queryByText('Spill details')).not.toBeInTheDocument();

  act(() => store.getState().startRoute({ tab: null, openCards: ['test'], cardKey: 'test', rowKey: null }));

  expect(screen.getByText('Spill details')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Spill' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTestId('widget-grid-item-test')).toHaveClass('scroll-mt-20', 'col-span-full');
});

test('a card the board does not list keeps its own disclosure and does not span', async () => {
  const user = userEvent.setup();
  render(
    <WidgetGrid>
      <TestCard cardId="alone" title="Alone" />
    </WidgetGrid>,
  );

  await user.click(screen.getByRole('button', { name: 'Alone' }));

  expect(screen.getByText('Alone details')).toBeVisible();
  expect(screen.getByTestId('widget-grid-item-alone')).not.toHaveClass('col-span-full');
  expect(store.getState().board.openCards.size).toBe(0);
});

test('a nested WidgetCard cannot affect its outer card\'s disclosure or grid span', () => {
  render(
    <BoardWithCards keys={['outer']}>
      <WidgetGrid>
        <WidgetGridItem cardId="outer">
          <WidgetCard title="Outer" defaultCollapsed>
            <WidgetCard title="Nested" defaultCollapsed={false}>nested details</WidgetCard>
          </WidgetCard>
        </WidgetGridItem>
      </WidgetGrid>
    </BoardWithCards>,
  );

  expect(screen.getByTestId('widget-grid-item-outer')).not.toHaveClass('col-span-full');
  expect(store.getState().board.openCards.size).toBe(0);
  expect(screen.getByRole('button', { name: 'Outer' })).toHaveAttribute('aria-expanded', 'false');
});
