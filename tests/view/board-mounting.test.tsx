// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types';
import { runState } from './_shared/run';

// The board mounts what is showing: a hidden tab holds no widgets, and a collapsed board card holds
// no body. What a widget remembers (a filter, a page) lives in the store, so hiding it loses nothing.

vi.mock('@core-src/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(() => new Promise(() => {})),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

const stages = [1, 2, 3].map((id) => ({
  id, name: `stage-${id}`, stageType: 'shuffle', submittedAt: id * 1_000, completedAt: id * 1_000 + 500,
  taskCount: 10, failedTasks: 0, shuffleReadBytes: 0, memoryBytesSpilled: 128 * 1024 * 1024, diskBytesSpilled: 0,
  gcPct: 0, fetchWaitTime: 0, executorRunTime: 500, inputBytes: 0, outputBytes: 0,
  taskDurationP50: 50, taskDurationP95: 250, taskDurationMax: 400, spillClassification: 'unclassified',
}));

function readyAppModel(): AppModel {
  return {
    ...emptyAppModel(),
    app: { name: 'Test application', startTime: 0, endTime: 60_000 },
    stages: new Map(stages.map((stage) => [stage.id, stage])) as unknown as AppModel['stages'],
  };
}

const spill = (stageId: number, band: Finding['impactBand']) => ({ type: 'spill', stageId, impactBand: band, value: 128 * 1024 * 1024, recommendation: `Review spill in Stage ${stageId}.` }) as Finding;

beforeEach(() => {
  window.history.replaceState({}, '', '/?impact=critical,warning,info');
  store.getState().resetModel();
  store.setState({ status: 'ready', ...runState({ appModel: readyAppModel(), catalog: [spill(1, 'critical'), spill(2, 'warning')] }, 'file-a'), activeFileId: 'file-a', widgetDensity: 'basic' });
});

test('a hidden tab renders no widgets, and showing it renders them', async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('tab', { name: 'Findings' });

  // Findings is showing: its board is mounted and the Full app report's widgets are not.
  expect(screen.getByRole('tabpanel', { name: 'Findings' })).toBeInTheDocument();
  expect(screen.queryByRole('tabpanel', { name: 'Full app report' })).not.toBeInTheDocument();
  expect(screen.queryAllByTestId(/^widget-grid-item-reference-/)).toHaveLength(0);
  expect(screen.queryByPlaceholderText('Filter by stage name or ID…')).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  expect(screen.getByPlaceholderText('Filter by stage name or ID…')).toBeInTheDocument();
  expect(screen.queryByRole('tabpanel', { name: 'Findings' })).not.toBeInTheDocument();
  expect(screen.queryByTestId('fix-these-first-row')).not.toBeInTheDocument();
});

test('what a widget remembers survives its tab hiding', async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('tab', { name: 'Findings' });
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));

  await user.type(screen.getByPlaceholderText('Filter by stage name or ID…'), '2');
  await user.click(screen.getByRole('tab', { name: 'Findings' }));
  expect(screen.queryByPlaceholderText('Filter by stage name or ID…')).not.toBeInTheDocument();

  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  expect(screen.getByPlaceholderText('Filter by stage name or ID…')).toHaveValue('2');
});

test('a board card that is open holds its body, and one that is closed does not', async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('tab', { name: 'Findings' });

  // The step's evidence is closed: no panel.
  const [first] = within(screen.getByRole('list', { name: 'Next steps' })).getAllByTestId('next-step');
  expect(within(first).queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
  await user.click(within(first).getByRole('button', { name: 'Show evidence' }));
  expect(await within(first).findByRole('heading', { name: 'Spill' })).toBeInTheDocument();
  await user.click(within(first).getByRole('button', { name: 'Hide evidence' }));
  expect(within(first).queryByRole('heading', { name: 'Spill' })).not.toBeInTheDocument();
});

test('a Full app report card outside the grid stays collapsed across a tab switch', async () => {
  const user = userEvent.setup();
  render(<App />);
  await screen.findByRole('tab', { name: 'Findings' });
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));

  const toggle = () => screen.getByRole('button', { name: /Wall-Clock Breakdown/ });
  expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  await user.click(toggle());
  expect(toggle()).toHaveAttribute('aria-expanded', 'false');

  await user.click(screen.getByRole('tab', { name: 'Findings' }));
  await user.click(screen.getByRole('tab', { name: 'Full app report' }));
  expect(toggle()).toHaveAttribute('aria-expanded', 'false');
});
