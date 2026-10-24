// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WidgetCard } from '../../src/view/WidgetCard';

test('renders title as a heading, open by default, and toggles the body on click', async () => {
  render(<WidgetCard title="Spill"><p>body</p></WidgetCard>);
  // Widget titles sit one level below the h2 section headers (All recommendations /
  // Suggested Improvements / Reference), so the card owns an h3, never an h2.
  expect(screen.getByRole('heading', { name: 'Spill', level: 3 })).toBeInTheDocument();
  expect(screen.getByText('body')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: /spill/i }));
  expect(screen.queryByText('body')).not.toBeVisible();
});

test('a non-collapsible card keeps the same level-3 title heading and no disclosure control', () => {
  render(<WidgetCard title="Metrics" collapsible={false}><p>body</p></WidgetCard>);
  expect(screen.getByRole('heading', { name: 'Metrics', level: 3 })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Metrics' })).not.toBeInTheDocument();
});

test('the disclosure trigger gets the comfortable coarse-pointer hit area', () => {
  render(<WidgetCard title="Spill"><p>body</p></WidgetCard>);
  expect(screen.getByRole('button', { name: 'Spill' })).toHaveClass('tap-target-comfortable');
});

test('a route-focused disclosure gets visible focus styling and clears it on blur', async () => {
  const user = userEvent.setup();

  render(
    <>
      <button>before</button>
      <WidgetCard title="Spill" routeFocused>details</WidgetCard>
    </>,
  );

  const trigger = screen.getByRole('button', { name: 'Spill' });
  expect(trigger).toHaveAttribute('data-route-focused');
  expect(trigger).toHaveClass('focus-visible:ring-[3px]');

  trigger.focus();
  await user.tab();

  expect(trigger).not.toHaveAttribute('data-route-focused');
});

test('an open collapsible card body carries the Card gap below its header', () => {
  render(<WidgetCard title="Spill"><p>body</p></WidgetCard>);
  // The Collapsible wraps header and body in one flex child, so the Card's own gap does not reach
  // between them: the body spaces itself.
  expect(screen.getByText('body').closest('[data-slot="card-content"]')).toHaveClass('pt-(--card-spacing)');
});

test('a collapsed card spaces its summary below the header', () => {
  render(<WidgetCard title="Spill" defaultCollapsed summary={<p>lead</p>}><p>body</p></WidgetCard>);
  expect(screen.getByText('lead').parentElement).toHaveClass('pt-label');
});
