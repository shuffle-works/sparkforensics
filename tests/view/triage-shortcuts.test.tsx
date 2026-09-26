// @vitest-environment jsdom
import { test, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { store, emptyAppModel } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';

function readyAppModel() {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    stages: new Map([
      [1, { id: 1, submittedAt: 0, completedAt: 1000 }],
      [2, { id: 2, submittedAt: 0, completedAt: 1000 }],
    ]),
  };
}

const catalog: Finding[] = [
  { type: 'spill', stageId: 1, impactBand: 'critical', recommendation: 'Reduce spill in Stage 1.' },
  { type: 'skew', stageId: 2, impactBand: 'warning', recommendation: 'Rebalance Stage 2.' },
];

function load(density: 'basic' | 'advanced') {
  store.setState({ status: 'ready', appModel: readyAppModel() as any, catalog, configFindings: [], widgetDensity: density });
  render(<App />);
  return screen.findByRole('tab', { name: 'Findings' });
}

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  // jsdom lays nothing out, so every control looks hidden to the visibility
  // filter; give buttons a client rect so the real ordering logic runs.
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(
    () => [{ width: 1, height: 1 }] as unknown as DOMRectList,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  store.setState({ widgetDensity: 'basic', status: 'idle', catalog: [], appModel: emptyAppModel() });
});

test('in Advanced view, j and k walk the verdict steps then the finding rows, in order', async () => {
  const user = userEvent.setup();
  await load('advanced');

  // Focus moves on the next animation frame (the Findings panel may only
  // just have become visible), so each press waits for it to land.
  const press = async (key: string, expected: RegExp) => {
    const before = document.activeElement;
    await user.keyboard(key);
    await waitFor(() => {
      expect(document.activeElement).not.toBe(before);
      expect(document.activeElement?.textContent).toMatch(expected);
    });
  };
  await press('j', /Show evidence/);
  const firstStep = document.activeElement;
  await press('j', /Show evidence/);
  // Two verdict steps, then the first recommendation row.
  await press('j', /Reduce spill in Stage 1\./);
  await press('k', /Show evidence/);
  await press('k', /Show evidence/);
  expect(document.activeElement).toBe(firstStep);
});

test('in Advanced view, 2 and 1 switch the report tabs and f jumps to the filters', async () => {
  const user = userEvent.setup();
  await load('advanced');

  await user.keyboard('2');
  expect(screen.getByRole('tab', { name: 'Full app report' })).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('1');
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');

  await user.keyboard('f');
  expect(document.activeElement).toHaveAccessibleName('Filter by impact: critical');
});

test('Basic view binds no single-key shortcuts', async () => {
  const user = userEvent.setup();
  await load('basic');
  const before = document.activeElement;

  await user.keyboard('j2');
  expect(document.activeElement).toBe(before);
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
});

test('shortcuts stay out of the way while typing and while a dialog is open', async () => {
  const user = userEvent.setup();
  await load('advanced');

  await user.click(screen.getByRole('button', { name: /filter by type/i }));
  const search = await screen.findByRole('menu');
  await user.keyboard('2');
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  expect(search).toBeInTheDocument();
  await user.keyboard('{Escape}');

  await act(async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
  });
  await user.keyboard('2');
  await waitFor(() => expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true'));
});

test('an open Select popup keeps its typeahead keys', async () => {
  const user = userEvent.setup();
  await load('advanced');
  render(
    <Select defaultValue="a">
      <SelectTrigger aria-label="Jump to stage">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">Stage 1</SelectItem>
        <SelectItem value="b">Stage 2</SelectItem>
      </SelectContent>
    </Select>,
  );

  await user.click(screen.getByRole('combobox', { name: 'Jump to stage' }));
  const listbox = await screen.findByRole('listbox');
  await user.keyboard('2');
  expect(screen.getByRole('tab', { name: 'Findings' })).toHaveAttribute('aria-selected', 'true');
  expect(listbox).toBeInTheDocument();
});
