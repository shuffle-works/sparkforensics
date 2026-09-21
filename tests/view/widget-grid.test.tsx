// @vitest-environment jsdom
import { expect, test, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';

import { WidgetCard } from '@/view/WidgetCard';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';
import {
  TriageNavigationProvider,
  type WidgetRegistration,
} from '@/view/TriageNavigationContext';

function TestCard({
  cardId,
  widgetId,
  title,
  defaultCollapsed = true,
  collapsedTile = false,
}: {
  cardId: string;
  widgetId?: string;
  title: string;
  defaultCollapsed?: boolean;
  collapsedTile?: boolean;
}) {
  return (
    <WidgetGridItem cardId={cardId} widgetId={widgetId} collapsedTile={collapsedTile}>
      <WidgetCard title={title} defaultCollapsed={defaultCollapsed}>
        <p>{title} details</p>
      </WidgetCard>
    </WidgetGridItem>
  );
}

function TestNavigationProvider({
  children,
  registerWidget,
  reportWidgetOpen = vi.fn(),
  focusedWidgetId = null,
}: {
  children: React.ReactNode;
  registerWidget: (widgetId: string, registration: WidgetRegistration) => () => void;
  reportWidgetOpen?: (widgetId: string, open: boolean) => void;
  focusedWidgetId?: string | null;
}) {
  return (
    <TriageNavigationProvider
      registerWidget={registerWidget}
      registerFindingAnchor={vi.fn(() => vi.fn())}
      reportWidgetOpen={reportWidgetOpen}
      clearRouteFocus={vi.fn()}
      focusedWidgetId={focusedWidgetId}
      activeRouteTarget={null}
      flashedFinding={null}
    >
      {children}
    </TriageNavigationProvider>
  );
}

function ControlledTestCard({
  cardId,
  widgetId,
  title,
  onOpenChange,
}: {
  cardId: string;
  widgetId: string;
  title: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    setOpen(nextOpen);
  };

  return (
    <WidgetGridItem cardId={cardId} widgetId={widgetId}>
      <WidgetCard title={title} open={open} onOpenChange={handleOpenChange}>
        <p>{title} details</p>
      </WidgetCard>
    </WidgetGridItem>
  );
}

test('grid cards expand, span, and collapse independently', async () => {
  const user = userEvent.setup();

  render(
    <WidgetGrid>
      <TestCard cardId="first" title="First" />
      <TestCard cardId="second" title="Second" />
    </WidgetGrid>,
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
  expect(screen.queryByText('First details')).not.toBeVisible();
  expect(second).toHaveClass('col-span-full');
  expect(screen.getByText('Second details')).toBeVisible();
});

test('a default-expanded grid card spans and can be collapsed', async () => {
  const user = userEvent.setup();

  render(
    <WidgetGrid>
      <TestCard cardId="available" title="Available" defaultCollapsed={false} />
    </WidgetGrid>,
  );

  const item = screen.getByTestId('widget-grid-item-available');
  expect(screen.getByText('Available details')).toBeVisible();
  expect(item).toHaveClass('col-span-full');

  await user.click(screen.getByRole('button', { name: 'Available' }));

  expect(screen.queryByText('Available details')).not.toBeVisible();
  expect(item).not.toHaveClass('col-span-full');
});

test('a collapsedTile grid item starts collapsed and floors its height regardless of defaultCollapsed', async () => {
  const user = userEvent.setup();

  render(
    <WidgetGrid>
      <TestCard cardId="reference" title="Reference" defaultCollapsed={false} collapsedTile />
    </WidgetGrid>,
  );

  // `collapsedTile` overrides the card's own `defaultCollapsed={false}`: it
  // still starts collapsed so every reference-region tile lines up.
  expect(screen.queryByText('Reference details')).not.toBeVisible();
  const card = screen.getByRole('heading', { name: 'Reference' }).closest('[data-slot="card"]');
  expect(card).toHaveClass('min-h-[6.5rem]');

  await user.click(screen.getByRole('button', { name: 'Reference' }));

  expect(screen.getByText('Reference details')).toBeVisible();
  expect(card).not.toHaveClass('min-h-[6.5rem]');
});

test('registers only the outer stable widget and opens it through its registration', async () => {
  let registration: WidgetRegistration | undefined;
  const registerWidget = vi.fn((_widgetId: string, nextRegistration: WidgetRegistration) => {
    registration = nextRegistration;
    return vi.fn();
  });

  render(
    <TestNavigationProvider registerWidget={registerWidget}>
      <WidgetGrid>
        <TestCard cardId="test" widgetId="spill" title="Spill" />
      </WidgetGrid>
    </TestNavigationProvider>,
  );

  expect(registerWidget).toHaveBeenCalledWith(
    'spill',
    expect.objectContaining({
      wrapperElement: expect.any(HTMLDivElement),
      open: expect.any(Function),
      getDisclosureButton: expect.any(Function),
    }),
  );
  expect(registration?.getDisclosureButton()).toBe(screen.getByRole('button', { name: 'Spill' }));

  act(() => registration?.open());

  await waitFor(() => expect(screen.getByText('Spill details')).toBeVisible());
  const item = screen.getByTestId('widget-grid-item-test');
  expect(item).toHaveClass('scroll-mt-20', 'col-span-full');
});

test('registration opens a controlled outer widget through its onOpenChange path', async () => {
  const user = userEvent.setup();
  const openChanges: boolean[] = [];
  let registration: WidgetRegistration | undefined;
  const registerWidget = vi.fn((_widgetId: string, nextRegistration: WidgetRegistration) => {
    registration = nextRegistration;
    return vi.fn();
  });

  render(
    <TestNavigationProvider registerWidget={registerWidget}>
      <WidgetGrid>
        <ControlledTestCard
          cardId="controlled"
          widgetId="spill"
          title="Controlled spill"
          onOpenChange={(nextOpen) => openChanges.push(nextOpen)}
        />
      </WidgetGrid>
    </TestNavigationProvider>,
  );

  act(() => registration?.open());

  await waitFor(() => expect(screen.getByText('Controlled spill details')).toBeVisible());
  const trigger = screen.getByRole('button', { name: 'Controlled spill' });
  expect(trigger).toHaveAttribute('aria-expanded', 'true');

  await user.click(trigger);

  await waitFor(() => expect(screen.getByText('Controlled spill details')).not.toBeVisible());
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await act(async () => {
    await Promise.resolve();
  });
  expect(openChanges).toEqual([true, false]);
});

test('does not acknowledge a route-open request that a controlled widget refuses', async () => {
  let registration: WidgetRegistration | undefined;
  const registerWidget = vi.fn((_widgetId: string, nextRegistration: WidgetRegistration) => {
    registration = nextRegistration;
    return vi.fn();
  });
  const reportWidgetOpen = vi.fn();
  const onOpenChange = vi.fn();

  render(
    <TestNavigationProvider
      registerWidget={registerWidget}
      reportWidgetOpen={reportWidgetOpen}
    >
      <WidgetGrid>
        <WidgetGridItem cardId="controlled" widgetId="spill">
          <WidgetCard title="Controlled spill" open={false} onOpenChange={onOpenChange}>
            Controlled spill details
          </WidgetCard>
        </WidgetGridItem>
      </WidgetGrid>
    </TestNavigationProvider>,
  );

  reportWidgetOpen.mockClear();
  act(() => registration?.open());

  await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(true));
  expect(screen.getByRole('button', { name: 'Controlled spill' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(screen.getByTestId('widget-grid-item-controlled')).not.toHaveClass('col-span-full');
  expect(reportWidgetOpen).not.toHaveBeenCalledWith('spill', true);
});

test('a nested WidgetCard cannot affect its outer widget registration or grid span', () => {
  const registerWidget = vi.fn(() => vi.fn());

  render(
    <TestNavigationProvider registerWidget={registerWidget}>
      <WidgetGrid>
        <WidgetGridItem cardId="outer" widgetId="outer">
          <WidgetCard title="Outer" defaultCollapsed>
            <WidgetCard title="Nested" defaultCollapsed={false}>nested details</WidgetCard>
          </WidgetCard>
        </WidgetGridItem>
      </WidgetGrid>
    </TestNavigationProvider>,
  );

  expect(registerWidget).toHaveBeenCalledTimes(1);
  expect(registerWidget).toHaveBeenCalledWith('outer', expect.any(Object));
  expect(screen.getByTestId('widget-grid-item-outer')).not.toHaveClass('col-span-full');
});
