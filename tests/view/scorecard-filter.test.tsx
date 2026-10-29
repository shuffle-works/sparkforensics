// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { testFinding } from './_shared/finding';

vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(() => new Promise(() => {})),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

beforeEach(() => {
  store.getState().resetModel();
  window.history.replaceState({}, '', '/');
});
afterEach(() => {
  cleanup();
  store.setState({ widgetDensity: 'basic' });
});

function renderRun(url: string) {
  window.history.replaceState({}, '', url);
  const appModel: AppModel = {
    ...emptyAppModel(),
    app: { name: 'Test application', startTime: 0, endTime: 60_000 },
    stages: new Map([[1, { id: 1, name: 'stage-1', submittedAt: 0, completedAt: 60_000 }]]) as unknown as AppModel['stages'],
  };
  store.setState({
    status: 'ready',
    appModel,
    catalog: [testFinding({ type: 'coldStart', value: 12, impactBand: 'info', recommendation: 'Warm the cluster.' })],
    activeFileId: 'file-a',
    widgetDensity: 'advanced',
  });
  render(<App />);
}

test.each([
  ['no filter', '/'],
  ['a filter that hides the cold-start finding', '/?impact=critical'],
])('the Scorecard states the cold start with %s', async (_label, url) => {
  renderRun(url);
  expect(await screen.findByTestId('kpi-wall-clock')).toHaveTextContent('12s cold start');
});
