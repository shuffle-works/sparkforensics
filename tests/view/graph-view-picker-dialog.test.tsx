// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GraphViewPickerDialog } from '@/view/GraphViewPickerDialog';

const entries = [
  { executionId: 1, stageId: 7, label: 'SELECT * FROM orders', secondary: '#1 · 1.2s' },
  { executionId: 2, stageId: 9, label: 'SQL execution #2', secondary: '#2' },
];

test('renders one row per entry, with its label and secondary line', () => {
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  expect(screen.getByText('Open plan graph')).toBeInTheDocument();
  expect(screen.getByText('SELECT * FROM orders')).toBeInTheDocument();
  expect(screen.getByText('#1 · 1.2s')).toBeInTheDocument();
  expect(screen.getByText('SQL execution #2')).toBeInTheDocument();
  expect(screen.getByText('#2')).toBeInTheDocument();
});

test('renders a Plan Violet icon before the dialog title', () => {
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  const title = screen.getByText('Open plan graph');
  expect(title.querySelector('svg')).toBeTruthy();
  expect(title.firstElementChild?.tagName).toBe('svg');
});

test('includes a dialog description explaining the picker', () => {
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  expect(screen.getByText("Choose which SQL execution's plan to open.")).toBeInTheDocument();
});

test('swaps visual roles: secondary renders as the bold primary line, label as the muted line', () => {
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  const secondaryLine = screen.getByText('#1 · 1.2s');
  const labelLine = screen.getByText('SELECT * FROM orders');
  expect(secondaryLine.className).toContain('font-medium');
  expect(labelLine.className).toContain('text-muted-foreground');
});

test('shows an impactBand dot and finding count when entry.impactBand is set', () => {
  const withFinding = [
    ...entries,
    { executionId: 3, stageId: 11, label: 'collect at Foo.scala:42', secondary: '#3 · 4.5s', impactBand: 'critical' as const, findingCount: 2 },
  ];
  render(<GraphViewPickerDialog open entries={withFinding} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  expect(screen.getByText('2 findings')).toBeInTheDocument();
});

test('renders no finding count when entry.impactBand is null', () => {
  const withoutFinding = [
    { executionId: 4, stageId: 12, label: 'collect at Bar.scala:1', secondary: '#4 · 0.1s', impactBand: null, findingCount: 0 },
  ];
  render(<GraphViewPickerDialog open entries={withoutFinding} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  expect(screen.queryByText(/finding/)).not.toBeInTheDocument();
});

test('typing in the filter narrows rows to matches on label or secondary', async () => {
  const user = userEvent.setup();
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  await user.type(screen.getByPlaceholderText('Filter executions…'), 'orders');
  expect(screen.getByText('SELECT * FROM orders')).toBeInTheDocument();
  expect(screen.queryByText('SQL execution #2')).not.toBeInTheDocument();
});

test('closing and reopening the picker clears the previous filter query', async () => {
  const user = userEvent.setup();
  const props = { entries, onSelect: vi.fn(), onOpenChange: vi.fn() };
  const { rerender } = render(<GraphViewPickerDialog open {...props} />);

  await user.type(screen.getByPlaceholderText('Filter executions…'), 'orders');
  expect(screen.queryByText('SQL execution #2')).not.toBeInTheDocument();

  rerender(<GraphViewPickerDialog open={false} {...props} />);
  rerender(<GraphViewPickerDialog open {...props} />);

  expect(screen.getByPlaceholderText('Filter executions…')).toHaveValue('');
  expect(screen.getByText('SELECT * FROM orders')).toBeInTheDocument();
  expect(screen.getByText('SQL execution #2')).toBeInTheDocument();
});

test('a filter matching nothing shows a "no matching executions" message and no rows', async () => {
  const user = userEvent.setup();
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  await user.type(screen.getByPlaceholderText('Filter executions…'), 'zzz-nope');
  expect(screen.getByText('No matching executions')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /SELECT|SQL execution/ })).not.toBeInTheDocument();
});

test('narrowing to exactly one row then pressing Enter in the filter calls onSelect with that row\'s stage id', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<GraphViewPickerDialog open entries={entries} onSelect={onSelect} onOpenChange={vi.fn()} />);
  const input = screen.getByPlaceholderText('Filter executions…');
  await user.type(input, 'orders');
  await user.type(input, '{Enter}');
  expect(onSelect).toHaveBeenCalledWith(7);
});

test('ArrowDown on a row button moves focus to the next visible row button', async () => {
  const user = userEvent.setup();
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  const firstButton = screen.getByText('SELECT * FROM orders').closest('button')!;
  const secondButton = screen.getByText('SQL execution #2').closest('button')!;
  firstButton.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(secondButton);
});

test('ArrowDown from the filter input moves focus into the first visible row button', async () => {
  const user = userEvent.setup();
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  const input = screen.getByPlaceholderText('Filter executions…');
  const firstButton = screen.getByText('SELECT * FROM orders').closest('button')!;
  input.focus();
  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(firstButton);
});

test('clicking a row calls onSelect with that entry\'s stage id', async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(<GraphViewPickerDialog open entries={entries} onSelect={onSelect} onOpenChange={vi.fn()} />);
  await user.click(screen.getByText('SELECT * FROM orders'));
  expect(onSelect).toHaveBeenCalledWith(7);
});

test('renders nothing when closed', () => {
  render(<GraphViewPickerDialog open={false} entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  expect(screen.queryByText('SELECT * FROM orders')).not.toBeInTheDocument();
});

test('caps dialog height and keeps header fixed while only the row list scrolls', () => {
  render(<GraphViewPickerDialog open entries={entries} onSelect={vi.fn()} onOpenChange={vi.fn()} />);
  const content = screen.getByRole('dialog');
  expect(content.className).toContain('max-h-[85vh]');
  expect(content.className).toContain('flex');
  expect(content.className).toContain('flex-col');
  // The popup itself must not scroll, or the header/close button scroll off with the list.
  expect(content.className).not.toContain('overflow-y-auto');

  const list = screen.getByRole('list');
  expect(list.className).toContain('overflow-y-auto');

  // Title must live outside the scrolling list, not share the list's scroll box.
  const title = screen.getByText('Open plan graph');
  const titleScrollAncestor = title.closest('.overflow-y-auto');
  expect(titleScrollAncestor).not.toBe(list);
});
