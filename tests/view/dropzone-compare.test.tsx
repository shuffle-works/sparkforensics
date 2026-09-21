// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocsProvider } from '@/view/DocsContext';
import { DropZone } from '@/view/DropZone';

// Same mocks as tests/view/dropzone.test.tsx: DropZone renders inside
// DocsProvider (DocsLink requires it) and useIngest/recentFiles are mocked so
// compare mode's non-parsing path never touches the real ingest pipeline.
vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad: vi.fn(),
    startLoadFolder: vi.fn(),
    startLoadFromUrl: vi.fn(),
    pickRecent: vi.fn(),
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

test('compare mode emits a file RunSource via onPick instead of parsing', async () => {
  const user = userEvent.setup();
  const onPick = vi.fn();
  render(
    <DocsProvider>
      <DropZone onPick={onPick} compact />
    </DocsProvider>,
  );
  // Force the hidden-input fallback (native picker is undrivable), per CLAUDE.md.
  (window as any).showOpenFilePicker = undefined;
  const file = new File(['{}'], 'run-a.zstd', { type: 'application/octet-stream' });
  await user.upload(screen.getByTestId('file-input'), file);
  expect(onPick).toHaveBeenCalledTimes(1);
  const source = onPick.mock.calls[0][0];
  expect(source).toMatchObject({ kind: 'file', label: 'run-a.zstd' });
  expect(source.file).toBe(file);
  expect(typeof source.id).toBe('string');
});

test('compare mode keeps rolling-folder and Spark History Server controls directly available', () => {
  render(
    <DocsProvider>
      <DropZone onPick={vi.fn()} compact />
    </DocsProvider>,
  );

  expect(screen.queryByRole('button', { name: 'Other sources' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /choose rolling-log folder/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /fetch from spark history server/i })).toBeInTheDocument();
});

test('keeps compact compare-source controls comfortable to tap', () => {
  render(
    <DocsProvider>
      <DropZone onPick={vi.fn()} compact />
    </DocsProvider>,
  );

  expect(screen.getByRole('button', { name: 'Choose file' })).toHaveClass('tap-target-comfortable');
  expect(screen.getByRole('button', { name: /choose rolling-log folder/i })).toHaveClass('tap-target-comfortable');
  expect(screen.getByRole('button', { name: /fetch from spark history server/i })).toHaveClass('tap-target-comfortable');
});
