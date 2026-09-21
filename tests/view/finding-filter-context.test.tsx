// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  FindingFilterProvider,
  useFindingFilter,
} from '@/view/FindingFilterContext';
import type { FilterOptions } from '@/view/finding-filter';

const OPTIONS: FilterOptions = { impactBands: ['critical', 'warning', 'info'], types: ['skew', 'spill'], stages: [3, 7] };

function Probe() {
  const { selection, toggleImpactBand, clearAll } = useFindingFilter();
  return (
    <div>
      <span data-testid="impact">{[...selection.impactBands].sort().join(',')}</span>
      <button onClick={() => toggleImpactBand('critical')}>toggle-critical</button>
      <button onClick={clearAll}>clear</button>
    </div>
  );
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

test('seeds selection from the URL on mount', () => {
  window.history.replaceState({}, '', '/?impact=critical,warning&type=skew&stage=3');
  render(<FindingFilterProvider options={OPTIONS}><Probe /></FindingFilterProvider>);
  expect(screen.getByTestId('impact').textContent).toBe('critical,warning');
});

test('toggling writes the query via replaceState with no history push', async () => {
  const user = userEvent.setup();
  render(<FindingFilterProvider options={OPTIONS}><Probe /></FindingFilterProvider>);
  const lengthBefore = window.history.length;

  await user.click(screen.getByText('toggle-critical'));
  expect(new URLSearchParams(window.location.search).get('impact')).toBe('critical');
  expect(window.history.length).toBe(lengthBefore); // replaceState, never pushState

  await user.click(screen.getByText('clear'));
  expect(window.location.search).toBe(''); // params removed when unconstrained
  expect(window.history.length).toBe(lengthBefore);
});

test('popstate re-applies filters from the restored URL', () => {
  render(<FindingFilterProvider options={OPTIONS}><Probe /></FindingFilterProvider>);
  expect(screen.getByTestId('impact').textContent).toBe('');

  act(() => {
    window.history.replaceState({}, '', '/?impact=warning');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  expect(screen.getByTestId('impact').textContent).toBe('warning');
});

test('changing fileId clears the selection (a new file is a fresh investigation)', async () => {
  const user = userEvent.setup();
  const { rerender } = render(
    <FindingFilterProvider options={OPTIONS} fileId="file-A"><Probe /></FindingFilterProvider>,
  );

  await user.click(screen.getByText('toggle-critical'));
  expect(screen.getByTestId('impact').textContent).toBe('critical');
  expect(window.location.search).toBe('?impact=critical');

  rerender(<FindingFilterProvider options={OPTIONS} fileId="file-B"><Probe /></FindingFilterProvider>);
  expect(screen.getByTestId('impact').textContent).toBe(''); // reset on file switch
  expect(window.location.search).toBe(''); // and its params stripped

  // Same file re-render (e.g. a catalog refresh) must NOT clear an active filter.
  await user.click(screen.getByText('toggle-critical'));
  rerender(<FindingFilterProvider options={OPTIONS} fileId="file-B"><Probe /></FindingFilterProvider>);
  expect(screen.getByTestId('impact').textContent).toBe('critical');
});
