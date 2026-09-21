// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportApp } from '@/export/ExportApp';
import { store, emptyAppModel } from '@/store/store';

// Dashboard/PlanGraphRoute both call useIngest()/useRecentFiles() internally
// (reused unmodified, per the spec): stub the same way tests/view/app-shell.test.tsx does.
const startLoad = vi.fn();
vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad, startLoadFolder: vi.fn(), startLoadFromUrl: vi.fn(),
    resetToDropZone: vi.fn(), getTaskData: vi.fn(), pickRecent: vi.fn(),
    prepareComparison: vi.fn(), drillIntoRun: vi.fn(),
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

if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

beforeEach(() => {
  startLoad.mockClear();
  store.getState().resetModel();
  store.setState({
    exportMode: true,
    status: 'ready',
    appModel: { ...emptyAppModel(), app: { name: 'Test App' } },
  });
});

test('renders the dashboard when no plan graph is open', async () => {
  render(<ExportApp />);
  expect((await screen.findAllByText('Test App')).length).toBeGreaterThan(0);
  expect(screen.getByRole('main')).toBeInTheDocument();
});

test('routes to the plan graph when planGraph.active is set', async () => {
  store.setState({ planGraph: { active: true, stageId: 1, initialScope: 'segment' } });
  render(<ExportApp />);
  // PlanGraphRoute renders this heading unconditionally (before any
  // planTree/model resolution), so it's a stable signal that the real
  // component mounted, not the now-removed Suspense fallback.
  expect(await screen.findByRole('heading', { name: /plan graph: stage 1/i })).toBeInTheDocument();
});

test('drag-and-drop onto the exported dashboard is disabled, not just visually hidden', async () => {
  render(<ExportApp />);
  await screen.findAllByText('Test App');
  const dashboard = screen.getByTestId('dashboard');
  const file = new File(['line one'], 'dropped.log', { type: 'text/plain' });

  fireEvent.dragOver(dashboard, { dataTransfer: { files: [file], types: ['Files'] } });
  expect(screen.queryByText(/drop to load a new event log/i)).not.toBeInTheDocument();

  fireEvent.drop(dashboard, { dataTransfer: { files: [file], types: ['Files'] } });
  expect(startLoad).not.toHaveBeenCalled();
});
