// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DocsProvider } from '@/view/DocsContext';
import { DropZone } from '@/view/DropZone';
import { store } from '@/store/store';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';

const startLoad = vi.fn();
const startLoadFolder = vi.fn();
const startLoadFromUrl = vi.fn();

vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad,
    startLoadFolder,
    startLoadFromUrl,
    resetToDropZone: vi.fn(),
    getTaskData: vi.fn(),
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

beforeEach(() => {
  startLoad.mockClear();
  startLoadFolder.mockClear();
  startLoadFromUrl.mockClear();
  vi.mocked(recentFiles.list).mockResolvedValue([]);
  store.getState().setError(null);
  store.getState().setShsParsing(false);
  vi.unstubAllGlobals();
  // Every render fires the local-server reachability probe (a plain
  // fetch('/shs-proxy')) on mount; default it to a safe "unreachable" 404 so
  // unrelated tests never make a real network call. Tests that care about the
  // reachable path override this with their own vi.stubGlobal('fetch', ...).
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
});

/** jsdom's file input has no real filesystem behind it, so multi-file
 * selection must be forced onto the `files` property directly rather than
 * going through userEvent.upload (which enforces the `multiple` attribute
 * that <input webkitdirectory> intentionally doesn't set). */
function setInputFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

// SHS-parsing is a single store flag (set by useIngest.startLoadFromUrl);
// seed it directly to render the "fetching" intake state.
function renderDropZone({ shsParsing = false }: { shsParsing?: boolean } = {}) {
  store.getState().setShsParsing(shsParsing);
  return render(
    <DocsProvider>
      <DropZone />
    </DocsProvider>,
  );
}

async function openOtherSources(user: ReturnType<typeof userEvent.setup>) {
  const trigger = screen.getByRole('button', { name: 'Other sources' });
  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
}

test('setting files on the hidden file input calls startLoad', async () => {
  renderDropZone();
  const input = screen.getByTestId('file-input') as HTMLInputElement;
  const file = new File(['line one'], 'app.log', { type: 'text/plain' });

  await userEvent.upload(input, file);

  expect(startLoad).toHaveBeenCalledTimes(1);
  expect(startLoad.mock.calls[0][0]).toBe(file);
});

test('clicking "Try a sample run" fetches the bundled sample and calls startLoad with it', async () => {
  const blob = new Blob(['sample bytes']);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => blob }) as unknown as Response));
  renderDropZone();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Try a sample run' }));

  expect(fetch).toHaveBeenCalledWith('sample-runs/sample-run.ndjson.gz');
  await waitFor(() => expect(startLoad).toHaveBeenCalledTimes(1));
  const loadedFile = startLoad.mock.calls[0][0] as File;
  expect(loadedFile.name).toBe('sample-run.ndjson.gz');
  // Loaded under the fixed sample id, so the dashboard can say it is the sample.
  expect(startLoad.mock.calls[0][1]).toEqual({ id: 'sample-run' });
});

test('a failed sample-run fetch surfaces a recoverable store error instead of throwing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
  renderDropZone();
  const user = userEvent.setup();

  await user.click(screen.getByRole('button', { name: 'Try a sample run' }));

  await waitFor(() => expect(store.getState().errorMessage).toMatch(/could not load the sample run/i));
  expect(startLoad).not.toHaveBeenCalled();
});

test('hides "Try a sample run" in compact mode (the two-run comparison slots)', () => {
  render(
    <DocsProvider>
      <DropZone compact />
    </DocsProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Try a sample run' })).not.toBeInTheDocument();
});

test('keeps landing links and History Server inputs comfortable on touch devices', async () => {
  const user = userEvent.setup();
  renderDropZone();

  await user.click(screen.getByRole('button', { name: /other sources/i }));
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  for (const input of [
    screen.getByLabelText(/spark history server base url/i),
    screen.getByLabelText(/^application id$/i),
    screen.getByLabelText(/attempt id/i),
  ]) {
    expect(input).toHaveClass('tap-target-input');
  }
});

test('dropping a file onto the drop zone calls startLoad', async () => {
  renderDropZone();
  const zone = screen.getByTestId('drop-zone');
  const file = new File(['line one'], 'dropped.log', { type: 'text/plain' });

  fireEvent.drop(zone, {
    dataTransfer: {
      files: [file],
      items: [{ kind: 'file', webkitGetAsEntry: () => null }],
      types: ['Files'],
    },
  });

  await waitFor(() => expect(startLoad).toHaveBeenCalledTimes(1));
  expect(startLoad.mock.calls[0][0]).toBe(file);
});

test('keeps alternative sources hidden until their disclosure is opened, then keeps SHS collapsed until opened by keyboard', async () => {
  renderDropZone();
  const user = userEvent.setup();

  const otherSources = screen.getByRole('button', { name: 'Other sources' });
  expect(otherSources).toHaveAttribute('aria-expanded', 'false');
  expect(otherSources).toHaveAttribute('aria-controls', 'other-sources-panel');
  expect(screen.queryByRole('button', { name: /choose rolling-log folder/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /fetch from spark history server/i })).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/spark history server base url/i)).not.toBeInTheDocument();

  otherSources.focus();
  await user.keyboard(' ');

  expect(otherSources).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: /choose rolling-log folder/i })).toBeInTheDocument();
  const trigger = screen.getByRole('button', { name: /fetch from spark history server/i });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveAttribute('aria-controls', 'shs-fetch-panel');

  trigger.focus();
  await user.keyboard(' ');

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await user.keyboard(' ');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await user.keyboard('{Enter}');

  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText(/spark history server base url/i)).toBeInTheDocument();
});

test('flips each disclosure\'s chevron between collapsed and expanded independently', async () => {
  renderDropZone();
  const user = userEvent.setup();

  const otherSources = screen.getByRole('button', { name: 'Other sources' });
  // Scoped to the Other sources section: the "Where do I find my event log?"
  // guide carries its own independent chevron.
  const container = otherSources.closest('section') as HTMLElement;
  expect(container.querySelector('.lucide-chevron-down')).toBeInTheDocument();
  expect(container.querySelector('.lucide-chevron-up')).not.toBeInTheDocument();

  await user.click(otherSources);

  // "Other sources" now points up; the still-collapsed SHS trigger it reveals points down.
  expect(container.querySelectorAll('.lucide-chevron-up')).toHaveLength(1);
  expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(1);

  const shsTrigger = screen.getByRole('button', { name: /fetch from spark history server/i });
  await user.click(shsTrigger);

  expect(container.querySelectorAll('.lucide-chevron-up')).toHaveLength(2);
  expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(0);

  await user.click(shsTrigger);

  expect(container.querySelectorAll('.lucide-chevron-up')).toHaveLength(1);
  expect(container.querySelectorAll('.lucide-chevron-down')).toHaveLength(1);
});

test('remembers the SHS text inputs across visits via localStorage', async () => {
  const user = userEvent.setup();
  const firstVisit = renderDropZone();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  await user.type(screen.getByLabelText(/spark history server base url/i), 'http://history-server:18080');
  await user.type(screen.getByLabelText(/^application id$/i), 'application_0000000000000_0001');
  await user.type(screen.getByLabelText(/attempt id/i), '3');

  firstVisit.unmount();

  renderDropZone();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  expect(screen.getByLabelText(/spark history server base url/i)).toHaveValue('http://history-server:18080');
  expect(screen.getByLabelText(/^application id$/i)).toHaveValue('application_0000000000000_0001');
  expect(screen.getByLabelText(/attempt id/i)).toHaveValue('3');
});

test('shows a local-server-detected callout above "Other sources" when the reachability probe returns 400', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response));
  renderDropZone();

  const callout = await screen.findByText(/if a spark history server is reachable/i);
  expect(callout).toBeInTheDocument();
  expect(fetch).toHaveBeenCalledWith('/shs-proxy', expect.objectContaining({ signal: expect.anything() }));

  // The callout only points at the disclosure; it doesn't move or auto-expand it.
  const otherSources = screen.getByRole('button', { name: 'Other sources' });
  expect(otherSources).toHaveAttribute('aria-expanded', 'false');
});

test('shows no callout when the reachability probe is not a 400 (zero-backend static deploy)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 }) as unknown as Response));
  renderDropZone();

  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/shs-proxy', expect.anything()));
  expect(screen.queryByText(/if a spark history server is reachable/i)).not.toBeInTheDocument();
});

test('shows no callout when the reachability probe rejects (network error)', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network error'); }));
  renderDropZone();

  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/shs-proxy', expect.anything()));
  expect(screen.queryByText(/if a spark history server is reachable/i)).not.toBeInTheDocument();
});

test('compact mode never shows the callout and skips the reachability probe entirely', async () => {
  const fetchMock = vi.fn(async () => ({ ok: false, status: 400 }) as unknown as Response);
  vi.stubGlobal('fetch', fetchMock);
  render(
    <DocsProvider>
      <DropZone compact />
    </DocsProvider>,
  );

  await waitFor(() => expect(screen.getByRole('button', { name: /fetch from spark history server/i })).toBeInTheDocument());
  expect(screen.queryByText(/if a spark history server is reachable/i)).not.toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalledWith('/shs-proxy', expect.anything());
});

test('uses local file intake as the primary path and labels the rolling-folder alternative', async () => {
  renderDropZone();
  const user = userEvent.setup();

  expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
  expect(screen.getByText(/drop an event log file here/i)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /choose rolling-log folder/i })).not.toBeInTheDocument();
  expect(screen.queryByText(/eventlog_v2_\*/i)).not.toBeInTheDocument();

  await openOtherSources(user);

  expect(screen.getByRole('button', { name: /choose rolling-log folder/i })).toBeInTheDocument();
  expect(screen.getByText(/eventlog_v2_\*/i)).toBeInTheDocument();
});

test('makes every landing intake action comfortable to tap, including disclosures', async () => {
  renderDropZone();
  const user = userEvent.setup();

  expect(screen.getByRole('button', { name: 'Choose file' })).toHaveClass('tap-target-comfortable');
  const otherSources = screen.getByRole('button', { name: 'Other sources' });
  expect(otherSources).toHaveClass('tap-target-comfortable');

  await user.click(otherSources);

  expect(screen.getByRole('button', { name: /choose rolling-log folder/i })).toHaveClass('tap-target-comfortable');
  const historyServer = screen.getByRole('button', { name: /fetch from spark history server/i });
  expect(historyServer).toHaveClass('tap-target-comfortable');

  await user.click(historyServer);

  expect(screen.getByRole('button', { name: 'Fetch' })).toHaveClass('tap-target-comfortable');
});

test('makes populated landing recent-file controls comfortable to tap', async () => {
  vi.mocked(recentFiles.list).mockResolvedValue([
    {
      id: 'recent-id', name: 'recent.log', size: 76_000_000, lastModified: 1,
      handle: {} as FileSystemFileHandle, appName: null, issueCount: null, lastOpenedAt: 1,
    },
  ]);
  renderDropZone();

  expect(await screen.findByRole('button', { name: /recent\.log/i })).toHaveClass('tap-target-comfortable');
  expect(screen.getByRole('button', { name: /remove from recent files/i })).toHaveClass('tap-target-comfortable');
});

test('validates SHS fields after blur and associates errors with invalid inputs', async () => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  const baseUrl = screen.getByLabelText(/spark history server base url/i);
  await user.click(baseUrl);
  await user.tab();

  expect(screen.getByText(/enter an absolute http/i)).toBeInTheDocument();
  expect(baseUrl).toHaveAttribute('aria-invalid', 'true');
  expect(baseUrl).toHaveAttribute('aria-describedby', expect.stringContaining('base-url-error'));
  expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled();
});

test.each([
  'application_0000000000000_0001',
  'local-1700000000000',
  'app-standalone_01',
])('submits supported application ID %s as a normalized SHS request', async (appId) => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  await user.type(screen.getByLabelText(/spark history server base url/i), ' https://history-server:18080/shs/ ');
  await user.type(screen.getByLabelText(/^application id/i), ` ${appId} `);
  await user.type(screen.getByLabelText(/^attempt id/i), ' 2 ');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));

  expect(startLoadFromUrl).toHaveBeenCalledWith(
    { baseUrl: 'https://history-server:18080/shs/', appId, attemptId: '2' },
    expect.any(Function),
  );
});

test('shows SHS parsing progress in the mounted intake', () => {
  renderDropZone({ shsParsing: true });
  expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent(/fetching event log/i);
});

// Local loads clearing an in-flight SHS parse is owned by useIngest.begin()
// (tested in useIngest.test.tsx), not DropZone.

test.each([
  ['local-server-unavailable', /local server.*unavailable/i],
  ['upstream-unreachable', /could not be reached/i],
  ['application-not-found', /was not found/i],
  ['access-or-upstream-failure', /could not provide/i],
  ['invalid-event-log', /did not contain a supported event log/i],
])('recovers %s in the expanded disclosure without upstream details', async (code, expectedMessage) => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));

  const baseUrl = screen.getByLabelText(/spark history server base url/i);
  const appId = screen.getByLabelText(/^application id/i);
  await user.type(baseUrl, 'http://history-server:18080');
  await user.type(appId, 'application_1_9');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));

  const onShsError = startLoadFromUrl.mock.calls[0][1] as (error: { source: 'shs'; code: string }) => void;
  act(() => onShsError({ source: 'shs', code }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(expectedMessage);
  expect(alert).toHaveFocus();
  expect(baseUrl).toHaveValue('http://history-server:18080');
  expect(appId).toHaveValue('application_1_9');
  expect(screen.getByRole('button', { name: /fetch from spark history server/i })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Choose file' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /local-server setup/i })).toBeInTheDocument();
  expect(alert).not.toHaveTextContent('history-server:18080');
  expect(alert).not.toHaveTextContent('404');
});

test('shows the detail an invalid-event-log SHS error carries below the recovery copy', async () => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));
  await user.type(screen.getByLabelText(/spark history server base url/i), 'http://history-server:18080');
  await user.type(screen.getByLabelText(/^application id/i), 'application_1_9');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));

  const onShsError = startLoadFromUrl.mock.calls[0][1] as (error: { source: 'shs'; code: string; message?: string }) => void;
  const detail = 'The zip archive holds 2 application attempts. Download a single attempt, for example GET /api/v1/applications/<appId>/<attemptId>/logs.';
  act(() => onShsError({ source: 'shs', code: 'invalid-event-log', message: detail }));

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/did not contain a supported event log/i);
  expect(screen.getByTestId('shs-error-detail')).toHaveTextContent(detail);
  expect(alert).toContainElement(screen.getByTestId('shs-error-detail'));
  expect(alert).toHaveFocus();

  act(() => onShsError({ source: 'shs', code: 'invalid-event-log' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/did not contain a supported event log/i);
  expect(screen.queryByTestId('shs-error-detail')).not.toBeInTheDocument();
});

test('re-focuses the recovery alert when the same SHS failure occurs after a retry', async () => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  await user.click(screen.getByRole('button', { name: /fetch from spark history server/i }));
  await user.type(screen.getByLabelText(/spark history server base url/i), 'http://history-server:18080');
  await user.type(screen.getByLabelText(/^application id/i), 'application_1_9');
  await user.click(screen.getByRole('button', { name: 'Fetch' }));

  const firstError = startLoadFromUrl.mock.calls[0][1] as (error: { source: 'shs'; code: string }) => void;
  act(() => firstError({ source: 'shs', code: 'local-server-unavailable' }));
  expect(await screen.findByRole('alert')).toHaveFocus();

  await user.click(screen.getByRole('button', { name: 'Fetch' }));
  const secondError = startLoadFromUrl.mock.calls[1][1] as (error: { source: 'shs'; code: string }) => void;
  act(() => secondError({ source: 'shs', code: 'local-server-unavailable' }));

  expect(await screen.findByRole('alert')).toHaveFocus();
});

test('selecting a scrambled rolling-log folder calls startLoadFolder in numeric order', async () => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  const input = screen.getByTestId('folder-input') as HTMLInputElement;
  const file3 = new File(['c'], 'events_3_app', { type: 'text/plain' });
  const file1 = new File(['a'], 'events_1_app', { type: 'text/plain' });
  const file2 = new File(['b'], 'events_2_app', { type: 'text/plain' });

  setInputFiles(input, [file3, file1, file2]);

  await waitFor(() => expect(startLoadFolder).toHaveBeenCalledTimes(1));
  const orderedFiles = startLoadFolder.mock.calls[0][0] as File[];
  expect(orderedFiles.map((f) => f.name)).toEqual(['events_1_app', 'events_2_app', 'events_3_app']);
});

test('selecting a non-rolling folder does not call startLoadFolder and directs the user to Choose file', async () => {
  renderDropZone();
  const user = userEvent.setup();
  await openOtherSources(user);
  const input = screen.getByTestId('folder-input') as HTMLInputElement;
  const fileA = new File(['a'], 'plain-a.log', { type: 'text/plain' });
  const fileB = new File(['b'], 'plain-b.log', { type: 'text/plain' });

  setInputFiles(input, [fileA, fileB]);

  await waitFor(() =>
    expect(store.getState().errorMessage).toMatch(/choose file/i),
  );
  expect(startLoadFolder).not.toHaveBeenCalled();
  expect(store.getState().status).toBe('error');
});

/** Fakes the WebKit FileSystemDirectoryEntry/FileSystemFileEntry pair used by
 * a real directory drop, so `readDirectoryFiles`'s paginated readEntries()
 * loop and per-entry .file() calls exercise their real async/reject paths. */
function fakeDirEntry(files: File[]) {
  let delivered = false;
  const fileEntries = files.map((file) => ({
    isFile: true,
    file: (resolve: (f: File) => void) => resolve(file),
  }));
  return {
    isDirectory: true,
    createReader: () => ({
      readEntries: (resolve: (entries: unknown[]) => void) => {
        resolve(delivered ? [] : fileEntries);
        delivered = true;
      },
    }),
  };
}

test('dropping a rolling-log directory calls startLoadFolder in numeric order', async () => {
  renderDropZone();
  const zone = screen.getByTestId('drop-zone');
  const file2 = new File(['b'], 'events_2_app', { type: 'text/plain' });
  const file1 = new File(['a'], 'events_1_app', { type: 'text/plain' });

  fireEvent.drop(zone, {
    dataTransfer: {
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => fakeDirEntry([file2, file1]) }],
      types: ['Files'],
    },
  });

  await waitFor(() => expect(startLoadFolder).toHaveBeenCalledTimes(1));
  const orderedFiles = startLoadFolder.mock.calls[0][0] as File[];
  expect(orderedFiles.map((f) => f.name)).toEqual(['events_1_app', 'events_2_app']);
});

test('a directory-read failure while dropping surfaces a store error instead of an unhandled rejection', async () => {
  renderDropZone();
  const zone = screen.getByTestId('drop-zone');
  const failingDirEntry = {
    isDirectory: true,
    createReader: () => ({
      readEntries: (_resolve: (entries: unknown[]) => void, reject: (err: unknown) => void) => {
        reject(new Error('boom'));
      },
    }),
  };

  fireEvent.drop(zone, {
    dataTransfer: {
      files: [],
      items: [{ kind: 'file', webkitGetAsEntry: () => failingDirEntry }],
      types: ['Files'],
    },
  });

  await waitFor(() => expect(store.getState().errorMessage).toBe('Could not read the dropped folder.'));
  expect(startLoadFolder).not.toHaveBeenCalled();
  expect(store.getState().status).toBe('error');
});

test('the "Where do I find my event log?" guide explains where Spark writes logs and links onward', async () => {
  const user = userEvent.setup();
  renderDropZone();

  const toggle = screen.getByRole('button', { name: /where do i find my event log/i });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByText(/spark\.eventLog\.dir/)).not.toBeInTheDocument();

  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByText('spark.eventLog.enabled')).toBeInTheDocument();
  expect(screen.getByText('spark.eventLog.dir')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'More ways to get a log' }))
    .toHaveAttribute('href', 'docs/user-guide/alternative-log-retrieval.html');
});

test('the guide\'s sample-run link loads the bundled sample like the main button', async () => {
  const user = userEvent.setup();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['{}']) }) as unknown as Response));
  renderDropZone();

  await user.click(screen.getByRole('button', { name: /where do i find my event log/i }));
  await user.click(screen.getByRole('button', { name: 'Load the sample run' }));
  await waitFor(() => expect(startLoad).toHaveBeenCalledTimes(1));
});

test('compact mode (comparison slots) has no event-log guide', () => {
  render(
    <DocsProvider>
      <DropZone compact onPick={vi.fn()} />
    </DocsProvider>,
  );
  expect(screen.queryByRole('button', { name: /where do i find my event log/i })).not.toBeInTheDocument();
});
