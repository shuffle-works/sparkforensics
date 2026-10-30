// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { loadCoreUsageHistogram } from '@/view/core-usage-histogram-data';

vi.mock('@/view/core-usage-histogram-data', () => ({
  loadCoreUsageHistogram: vi.fn(async () => ({ histogram: [0, 1000], incomplete: false })),
}));
vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(() => new Promise(() => {})),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

const originalScrollIntoView = Element.prototype.scrollIntoView;
const originalMatchMedia = window.matchMedia;

function readyAppModel(name: string): AppModel {
  return {
    ...emptyAppModel(),
    app: { name, startTime: 0, endTime: 60_000 },
    stages: new Map([[1, { id: 1, name: 'stage-1' }]]) as unknown as AppModel['stages'],
  };
}

function showRun(name: string, activeFileId: string) {
  store.setState({
    status: 'ready',
    appModel: readyAppModel(name),
    catalog: [],
    activeFileId,
    taskDataCache: new Map(),
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
}

beforeEach(() => {
  store.getState().resetModel();
  Element.prototype.scrollIntoView = vi.fn();
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown as typeof window.matchMedia;
  vi.mocked(loadCoreUsageHistogram).mockClear();
});
afterEach(() => {
  cleanup();
  Element.prototype.scrollIntoView = originalScrollIntoView;
  window.matchMedia = originalMatchMedia;
});

test('the core-usage histogram loads again for the run a recent-run pick switches to', async () => {
  const user = userEvent.setup();
  showRun('run A', 'file-a');
  render(<App />);
  await user.click(await screen.findByRole('tab', { name: 'Full app report' }));
  await user.click(await screen.findByRole('button', { name: /core-usage distribution/i }));
  await waitFor(() => expect(loadCoreUsageHistogram).toHaveBeenCalledTimes(1));

  act(() => showRun('run B', 'file-b'));
  await user.click(await screen.findByRole('button', { name: /core-usage distribution/i }));

  await waitFor(() => expect(loadCoreUsageHistogram).toHaveBeenCalledTimes(2));
  expect(vi.mocked(loadCoreUsageHistogram).mock.calls[1][0].app?.name).toBe('run B');
});
