// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExportApp } from '@/export/ExportApp';
import { hydrateExportStore } from '@/export/hydrate-store';
import { UnsupportedPayload } from '@/export/UnsupportedPayload';
import { EXPORT_DATA_SCHEMA_VERSION, type ExportRunData } from '@sparkforensics/core/export-data.ts';
import { interpretRun } from '@sparkforensics/core/run-interpretation.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { store, emptyAppModel } from '@/store/store';
import { DocsLink, DocsProvider } from '@/view/DocsContext';
import { TagBadge } from '@/view/ImpactBadge';

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

// An exported dashboard (single-file download or --export-html folder alike)
// carries no docs: no Docs control, and every docs reference is plain text.
test('the exported dashboard links to no docs', async () => {
  render(<ExportApp />);
  await screen.findAllByText('Test App');
  expect(screen.queryByRole('link', { name: /docs/i })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /^docs$/i })).toBeNull();
  expect(document.querySelector('a[href*="docs"], iframe')).toBeNull();
});

test('docs references render as plain text in export mode', () => {
  store.getState().setWidgetDensity('advanced');
  try {
    render(
      <DocsProvider>
        <TagBadge type="skew" impactBand="warning" />
        <TagBadge type="jobFailureRate" impactBand="warning" />
        <p>
          See <DocsLink anchor="#memory-model">how the memory model works</DocsLink>.
        </p>
      </DocsProvider>,
    );
    expect(screen.getByText('SKEW')).toBeInTheDocument();
    expect(screen.getByText('JOBS')).toBeInTheDocument();
    expect(screen.getByText(/how the memory model works/)).toBeInTheDocument();
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  } finally {
    store.getState().setWidgetDensity('basic');
  }
});

// The bundle renders what the producer concluded. A title no core writes proves
// the verdict came from the payload, not from analysis run again at open time.
test('renders the payload\'s own verdict and names what produced the file', async () => {
  const catalog: Finding[] = [{
    type: 'spill', stageId: 3, impactBand: 'warning', recommendation: 'Raise executor memory.',
    impactEstimate: { basis: 'serial', wallClock: { low: 4000, high: 4000 }, estimateMethod: 'measured' },
  }];
  const interpretation = interpretRun(emptyAppModel(), catalog, []);
  const data = {
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
    provenance: { coreVersion: '0.1.0', buildId: '0123456789abcdef0123', producer: 'sparkforensics-analyze 9.9.9' },
    app: { name: 'Test App' },
    stages: [], jobs: [], sql: [],
    executors: { added: [], removed: [] },
    runAggregates: null, evidenceAvailability: null,
    catalog, configFindings: [], skippedLines: 0,
    interpretation: { ...interpretation, verdict: { ...interpretation.verdict, title: 'Stamped by the producer' } },
  } as unknown as ExportRunData;
  hydrateExportStore(data);

  render(<ExportApp />);

  expect(await screen.findByRole('heading', { level: 2, name: 'Stamped by the producer' })).toBeInTheDocument();
  expect(screen.getByTestId('run-verdict')).toHaveTextContent('Potential savings 4.0s of run time');
  expect(screen.getByTestId('export-provenance')).toHaveTextContent(
    'Exported by sparkforensics-analyze 9.9.9 · core 0.1.0 · build 0123456789ab',
  );
});

test('a payload version the bundle does not read gets a message, not a dashboard', () => {
  render(<UnsupportedPayload reason="This file holds export data format version 1, but this viewer only reads version 2." />);
  expect(screen.getByRole('alert')).toHaveTextContent('version 1, but this viewer only reads version 2');
  expect(screen.queryByTestId('dashboard')).toBeNull();
});
