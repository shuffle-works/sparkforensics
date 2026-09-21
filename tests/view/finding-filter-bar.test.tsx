// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { FindingFilterProvider } from '@/view/FindingFilterContext';
import { FindingFilterBar } from '@/view/FindingFilterBar';
import type { FilterOptions } from '@/view/finding-filter';

const OPTIONS: FilterOptions = {
  impactBands: ['critical', 'warning', 'info'],
  types: ['skew', 'smallFiles', 'underBroadcast'],
  stages: [3, 7],
};

function mount(options: FilterOptions, count = 5) {
  return render(
    <FindingFilterProvider options={options}>
      <FindingFilterBar options={options} resultCount={count} />
    </FindingFilterProvider>,
  );
}

beforeEach(() => window.history.replaceState({}, '', '/'));

test('impact renders as color-coded toggle pills with accessible names', () => {
  mount(OPTIONS);
  const critical = screen.getByRole('button', { name: 'Filter by impact: critical' });
  expect(critical).toBeInTheDocument();
  expect(critical).toHaveAttribute('aria-pressed', 'false');
});

test('type options live in an on-demand dropdown, including PLAN-tagged types', async () => {
  const user = userEvent.setup();
  mount(OPTIONS);
  await user.click(screen.getByRole('button', { name: /filter by type/i }));
  // Two PLAN-tagged types are independently offered.
  expect(await screen.findByRole('menuitemcheckbox', { name: 'Filter by type: smallFiles' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemcheckbox', { name: 'Filter by type: underBroadcast' })).toBeInTheDocument();
});

test('stage dropdown is searchable', async () => {
  const user = userEvent.setup();
  mount({ ...OPTIONS, stages: [3, 7, 42] });
  await user.click(screen.getByRole('button', { name: /filter by stage/i }));
  expect(await screen.findByRole('menuitemcheckbox', { name: 'Filter by stage: 3' })).toBeInTheDocument();

  await user.type(screen.getByRole('textbox', { name: /search stages/i }), '42');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Filter by stage: 42' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Filter by stage: 3' })).not.toBeInTheDocument();
});

test('type dropdown is searchable, matching either the type name or its tag', async () => {
  const user = userEvent.setup();
  mount(OPTIONS);
  await user.click(screen.getByRole('button', { name: /filter by type/i }));
  expect(await screen.findByRole('menuitemcheckbox', { name: 'Filter by type: skew' })).toBeInTheDocument();

  await user.type(screen.getByRole('textbox', { name: /search types/i }), 'broadcast');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Filter by type: underBroadcast' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Filter by type: skew' })).not.toBeInTheDocument();

  // Matches by tag ("PLAN") too, not just the raw type name.
  await user.clear(screen.getByRole('textbox', { name: /search types/i }));
  await user.type(screen.getByRole('textbox', { name: /search types/i }), 'plan');
  expect(screen.getByRole('menuitemcheckbox', { name: 'Filter by type: smallFiles' })).toBeInTheDocument();
  expect(screen.getByRole('menuitemcheckbox', { name: 'Filter by type: underBroadcast' })).toBeInTheDocument();
  expect(screen.queryByRole('menuitemcheckbox', { name: 'Filter by type: skew' })).not.toBeInTheDocument();
});

test('toggling an impact pill shows a removable chip; chip removal and clear-all clear it', async () => {
  const user = userEvent.setup();
  mount(OPTIONS);
  expect(screen.queryByRole('button', { name: /clear all filters/i })).not.toBeInTheDocument();

  const critical = screen.getByRole('button', { name: 'Filter by impact: critical' });
  await user.click(critical);
  expect(critical).toHaveAttribute('aria-pressed', 'true');
  const chip = screen.getByRole('button', { name: 'Remove filter: impact critical' });
  expect(chip).toBeInTheDocument();

  await user.click(chip); // chip removal toggles the value off
  expect(screen.getByRole('button', { name: 'Filter by impact: critical' })).toHaveAttribute('aria-pressed', 'false');

  await user.click(screen.getByRole('button', { name: 'Filter by impact: warning' }));
  await user.click(screen.getByRole('button', { name: /clear all filters/i }));
  expect(screen.queryByRole('button', { name: /^remove filter/i })).not.toBeInTheDocument();
});

test('toggling a type inside the dropdown produces a chip', async () => {
  const user = userEvent.setup();
  mount(OPTIONS);
  await user.click(screen.getByRole('button', { name: /filter by type/i }));
  await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Filter by type: skew' }));
  expect(screen.getByRole('button', { name: 'Remove filter: type skew' })).toBeInTheDocument();
});

test('impact pill is toggleable with the keyboard', async () => {
  const user = userEvent.setup();
  mount(OPTIONS);
  const pill = screen.getByRole('button', { name: 'Filter by impact: info' });
  pill.focus();
  await user.keyboard('[Enter]');
  expect(pill).toHaveAttribute('aria-pressed', 'true');
});

test('announces the result count via an aria-live region when a filter is active', async () => {
  const user = userEvent.setup();
  const { container } = mount(OPTIONS, 2);
  await user.click(screen.getByRole('button', { name: 'Filter by impact: warning' }));
  const live = container.querySelector('[aria-live="polite"]');
  expect(live).not.toBeNull();
  expect(live).toHaveTextContent('2 findings match the active filters');
});

test('renders nothing when there is nothing to filter', () => {
  const { container } = mount({ impactBands: [], types: [], stages: [] });
  expect(container).toBeEmptyDOMElement();
});

test('impact pills, filter chips, and clear-all carry the comfortable tap-target class', async () => {
  // These sub-44px controls must opt into the .tap-target-comfortable utility for coarse pointers.
  const user = userEvent.setup();
  mount(OPTIONS);

  const pill = screen.getByRole('button', { name: 'Filter by impact: critical' });
  expect(pill).toHaveClass('tap-target-comfortable');

  await user.click(pill); // activate a filter so the chip row renders
  expect(screen.getByRole('button', { name: 'Remove filter: impact critical' })).toHaveClass(
    'tap-target-comfortable',
  );
  expect(screen.getByRole('button', { name: /clear all filters/i })).toHaveClass('tap-target-comfortable');
});
