// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocsProvider } from '@/view/DocsContext';
import { CompareLanding } from '@/view/CompareLanding';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { store } from '@/store/store';

// CompareLanding renders a real <DropZone />, which needs a DocsProvider
// ancestor (DocsLink throws via useDocs() otherwise) and touches recent-files.js
// in an effect. useIngest is fully mocked so the DropZone-visible calls stay
// inert while startCompareLoad stays a spied fn CompareLanding can call.
const startCompareLoad = vi.fn();
vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad: vi.fn(),
    startLoadFolder: vi.fn(),
    startLoadFromUrl: vi.fn(),
    pickRecent: vi.fn(),
    resetToDropZone: vi.fn(),
    getTaskData: vi.fn(),
    startCompareLoad,
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
  startCompareLoad.mockClear();
  store.getState().setTheme('dark');
});

function renderLanding(props: { errorMessage?: string | null; errorNonce?: number } = {}) {
  return render(<ThemeProvider><DocsProvider><CompareLanding {...props} /></DocsProvider></ThemeProvider>);
}

test('landing exposes an accessible theme toggle that updates the document theme', async () => {
  const user = userEvent.setup();
  renderLanding();

  const toggle = screen.getByRole('button', { name: 'Toggle theme' });
  expect(toggle).toHaveClass('tap-target-comfortable');
  expect(toggle).toHaveAttribute('aria-pressed', 'false');

  await user.click(toggle);
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  expect(toggle).toHaveAttribute('aria-pressed', 'true');
});

test('single-run landing prioritizes one Spark event log and presents next investigation steps', () => {
  renderLanding();

  expect(screen.getByRole('heading', { name: /analyze a spark event log/i })).toBeVisible();
  expect(screen.getByText(/nothing leaves your machine/i)).toBeVisible();
  expect(screen.getByRole('heading', { name: /go further with the same evidence/i })).toBeVisible();
  expect(screen.getByRole('button', { name: /compare two runs/i })).toBeVisible();
  expect(screen.getByTestId('drop-zone')).toBeVisible();
  // The intake lives in the hero itself, so its actions are part of the first
  // thing a visitor reads rather than a section further down the page.
  const hero = screen.getByRole('heading', { name: /analyze a spark event log/i }).closest('section') as HTMLElement;
  expect(within(hero).getByTestId('drop-zone')).toBeInTheDocument();
  expect(within(hero).getByRole('button', { name: 'Try a sample run' })).toBeInTheDocument();
});

test('keeps landing actions comfortable to tap and compare slots stacked below the large breakpoint', async () => {
  const user = userEvent.setup();
  renderLanding();

  const compareAction = screen.getByRole('button', { name: /compare two runs/i });
  expect(compareAction).toHaveClass('tap-target-comfortable');

  await user.click(compareAction);

  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveClass('tap-target-comfortable');
  expect(screen.getByRole('button', { name: 'Compare' })).toHaveClass('tap-target-comfortable');
  expect(screen.getByTestId('compare-slot-a').parentElement?.parentElement).toHaveClass('lg:grid-cols-2');
  expect(screen.getByTestId('compare-slot-a').parentElement?.parentElement).not.toHaveClass('md:grid-cols-2');
});

test('toggle shows two slots; Compare enables only after both are filled', async () => {
  const user = userEvent.setup();
  renderLanding();
  await user.click(screen.getByRole('button', { name: /compare two runs/i }));
  (window as any).showOpenFilePicker = undefined;

  expect(screen.getByText(/run a as the baseline and run b as the candidate/i)).toBeVisible();
  expect(screen.getByText(/structurally matched stages/i)).toBeVisible();

  const compareBtn = screen.getByRole('button', { name: /^compare$/i });
  expect(compareBtn).toBeDisabled();

  const slotA = screen.getByTestId('compare-slot-a');
  const slotB = screen.getByTestId('compare-slot-b');
  await user.upload(within(slotA).getByTestId('file-input'), new File(['{}'], 'a.log'));
  expect(compareBtn).toBeDisabled(); // only one slot filled
  await user.upload(within(slotB).getByTestId('file-input'), new File(['{}'], 'b.log'));
  expect(compareBtn).toBeEnabled();
  for (const button of screen.getAllByRole('button', { name: 'Change' })) {
    expect(button).toHaveClass('tap-target-comfortable');
  }

  await user.click(compareBtn);
  expect(startCompareLoad).toHaveBeenCalledTimes(1);
  const [a, b] = startCompareLoad.mock.calls[0];
  expect(a.label).toBe('a.log');
  expect(b.label).toBe('b.log');
});

test('a file-load error renders as a focused alert, not a bare unstyled message', () => {
  renderLanding({ errorMessage: 'That file is not a Spark event log.', errorNonce: 1 });

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('That file is not a Spark event log.');
  expect(alert).toHaveFocus();
});

test('no alert renders when there is no error message', () => {
  renderLanding({ errorMessage: null });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('re-focuses the alert when errorNonce advances even though the message text is unchanged', () => {
  const { rerender } = renderLanding({ errorMessage: 'Permission to read this file was denied.', errorNonce: 1 });
  const alert = screen.getByRole('alert');
  expect(alert).toHaveFocus();

  alert.blur();
  expect(alert).not.toHaveFocus();

  rerender(
    <ThemeProvider><DocsProvider><CompareLanding errorMessage="Permission to read this file was denied." errorNonce={2} /></DocsProvider></ThemeProvider>,
  );
  expect(screen.getByRole('alert')).toHaveFocus();
});
