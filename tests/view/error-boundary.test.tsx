// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';

const cancelParse = vi.hoisted(() => vi.fn());
vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad: vi.fn(),
    startLoadFolder: vi.fn(),
    startLoadFromUrl: vi.fn(),
    resetToDropZone: vi.fn(),
    cancelParse,
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

// A dashboard chunk that fails to evaluate, like a stale hashed chunk that 404s after a deploy.
vi.mock('@/view/Dashboard', () => {
  throw new Error('chunk failed to load');
});

import App from '@/App';
import { store } from '@/store/store';

beforeEach(() => {
  // React logs every caught render error; keep the test output readable.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  cancelParse.mockClear();
  store.getState().resetModel();
  store.setState({ run: null, runKey: null, status: 'idle', activeFileId: null });
});

afterEach(() => vi.restoreAllMocks());

let widgetShouldThrow = true;
function FlakyWidget() {
  if (widgetShouldThrow) throw new Error('widget exploded');
  return <p>widget ok</p>;
}

test('a widget that throws shows an error card and leaves its siblings rendered', async () => {
  widgetShouldThrow = true;
  render(
    <WidgetGrid>
      <WidgetGridItem cardId="a"><FlakyWidget /></WidgetGridItem>
      <WidgetGridItem cardId="b"><p>sibling ok</p></WidgetGridItem>
    </WidgetGrid>,
  );

  expect(screen.getByRole('alert')).toHaveTextContent('This card could not be shown.');
  expect(screen.getByRole('alert')).toHaveTextContent('widget exploded');
  expect(screen.getByText('sibling ok')).toBeInTheDocument();

  widgetShouldThrow = false;
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(screen.getByText('widget ok')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

test('a dashboard chunk that fails to load shows the crash view, not a blank page', async () => {
  store.setState({ status: 'ready' });
  const { container } = render(<App />);

  expect(await screen.findByText('Something went wrong')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument();
  expect(container).not.toBeEmptyDOMElement();
});

test('"Load another log" drops the run and returns to the drop zone', async () => {
  store.setState({ status: 'ready' });
  render(<App />);
  await screen.findByText('Something went wrong');

  cancelParse.mockImplementation(() => {
    store.getState().resetModel();
    store.getState().setStatus('idle');
  });
  await userEvent.click(screen.getByRole('button', { name: 'Load another log' }));

  expect(cancelParse).toHaveBeenCalledOnce();
  expect(screen.getByTestId('drop-zone')).toBeInTheDocument();
  expect(screen.queryByText('Something went wrong')).toBeNull();
});

test('a dashboard that throws while rendering shows the crash view with the error message', async () => {
  const { ErrorBoundary, AppCrashView } = await import('@/view/ErrorBoundary');
  function Boom(): never { throw new Error('dashboard exploded'); }
  render(
    <ErrorBoundary fallback={(error) => <AppCrashView error={error} />}>
      <Boom />
    </ErrorBoundary>,
  );

  expect(screen.getByRole('alert')).toHaveTextContent('dashboard exploded');
  expect(screen.queryByRole('button', { name: 'Load another log' })).toBeNull();
});
