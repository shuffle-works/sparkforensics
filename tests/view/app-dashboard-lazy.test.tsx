// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

const dashboardModule = vi.hoisted(() => {
  const load = new Promise<void>(() => {});
  return { evaluated: false, load };
});

vi.mock('@/view/Dashboard', async () => {
  dashboardModule.evaluated = true;
  await dashboardModule.load;
  return { Dashboard: () => <main>Dashboard</main> };
});

vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad: vi.fn(),
    startLoadFolder: vi.fn(),
    startLoadFromUrl: vi.fn(),
    resetToDropZone: vi.fn(),
    getTaskData: vi.fn(),
    pickRecent: vi.fn(),
  }),
}));

vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(async () => []),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

import App from '@/App';
import { emptyAppModel, store } from '@/store/store';

beforeEach(() => {
  store.setState({
    appModel: emptyAppModel(),
    catalog: [],
    status: 'idle',
    shsParsing: false,
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
});

test('idle landing does not load the dashboard implementation', () => {
  render(<App />);

  expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  expect(dashboardModule.evaluated).toBe(false);
});

test('ready dashboard route announces loading while its chunk is pending', () => {
  store.setState({ status: 'ready' });

  render(<App />);

  expect(screen.getByRole('status', { name: 'Loading dashboard' })).toHaveTextContent('Loading dashboard…');
});
