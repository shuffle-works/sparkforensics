// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { store, emptyAppModel } from '@/store/store';

// Mirror the real useIngest contract for the SHS-parsing store flag: every
// parse routes through begin() (which clears it) and only startLoadFromUrl
// re-sets it, so a local load supersedes an in-flight SHS fetch.
const startLoadFromUrl = vi.fn((_request: unknown, _onShsError: unknown) => {
  store.getState().setStatus('parsing');
  store.getState().setShsParsing(true);
});
const startLoad = vi.fn(() => {
  store.getState().setShsParsing(false);
  store.getState().setStatus('parsing');
});

vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad,
    startLoadFolder: vi.fn(),
    startLoadFromUrl,
    resetToDropZone: vi.fn(),
    getTaskData: vi.fn(),
    pickRecent: vi.fn(),
  }),
}));

// DropZone renders in the idle/error routes; it reads recentFiles on mount,
// which touches indexedDB; stub it out the same way tests/view/dropzone.test.tsx does.
vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(async () => []),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

beforeEach(() => {
  store.setState({
    appModel: emptyAppModel(),
    catalog: [],
    status: 'idle',
    shsParsing: false,
    errorMessage: null,
    parse: { pct: 0, lines: 0, etaMs: null },
  });
  startLoadFromUrl.mockClear();
  startLoad.mockClear();
});

test('idle status shows the drop zone', () => {
  render(<App />);
  expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
});

test('page has exactly one sr-only h1 naming the app', () => {
  render(<App />);
  const headings = screen.getAllByRole('heading', { level: 1 });
  expect(headings).toHaveLength(1);
  expect(headings[0]).toHaveTextContent('SparkForensics');
  expect(headings[0]).toHaveClass('sr-only');
});

test('error status still shows the drop zone (with the error surfaced)', () => {
  store.setState({ status: 'error', errorMessage: 'Could not read the selected file.' });
  render(<App />);
  expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  expect(screen.getByText('Could not read the selected file.')).toBeInTheDocument();
});

test('parsing status shows a progress bar', () => {
  store.setState({ status: 'parsing' });
  render(<App />);
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
});

test('parsing status announces live percent and line count via role=status', () => {
  store.setState({ status: 'parsing', parse: { pct: 0.42, lines: 5000, etaMs: null } });
  render(<App />);
  const label = screen.getByRole('status');
  expect(label).toHaveTextContent(`Parsing… 42% · ${(5000).toLocaleString()} lines`);
});

test('an SHS parse keeps the intake mounted and renders its local progress state', async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Other sources' }));
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));
  await user.type(screen.getByLabelText(/spark history server base url/i), 'http://history-server:18080');
  await user.type(screen.getByLabelText(/^application id/i), 'application_1_9');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));

  await waitFor(() => expect(screen.getByTestId('drop-zone')).toBeInTheDocument());
  expect(screen.getByRole('status')).toHaveTextContent(/fetching event log/i);
  expect(startLoadFromUrl).toHaveBeenCalledTimes(1);
});

test('switching to a local load during an SHS fetch clears the stale SHS progress', async () => {
  render(<App />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Other sources' }));
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));
  await user.type(screen.getByLabelText(/spark history server base url/i), 'http://history-server:18080');
  await user.type(screen.getByLabelText(/^application id/i), 'application_1_9');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/fetching event log/i));

  // A local load begins while the SHS fetch is still flagged as parsing.
  const fileInput = screen.getByTestId('file-input') as HTMLInputElement;
  await user.upload(fileInput, new File(['line one'], 'app.log', { type: 'text/plain' }));

  // The intake must not keep showing the SHS "Fetching event log…" state for
  // the whole local parse; the local parse route renders instead.
  await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument());
  expect(screen.queryByText(/fetching event log/i)).not.toBeInTheDocument();
});

test('ready status shows the dashboard: topbar app name + empty main widget region', async () => {
  store.setState({ status: 'ready', appModel: { ...emptyAppModel(), app: { name: 'Test App' } } });
  render(<App />);
  // Appears twice: the Topbar name/sub block and the FileSwitcher trigger.
  expect((await screen.findAllByText('Test App')).length).toBeGreaterThan(0);
  expect(screen.getByRole('main')).toBeInTheDocument();
});
