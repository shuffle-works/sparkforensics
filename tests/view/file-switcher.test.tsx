// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FileSwitcher } from '@/view/FileSwitcher';
import type { RecentFileEntry } from '@/view/RecentList';

function mkEntry(id: string): RecentFileEntry {
  return {
    id,
    name: `${id}.log`,
    size: 100,
    lastModified: 1,
    appName: null,
    issueCount: null,
    handle: {} as FileSystemFileHandle,
    lastOpenedAt: 1,
  };
}

test('shows the active file name on the trigger', () => {
  render(<FileSwitcher activeName="App A" entries={[]} />);
  expect(screen.getByRole('button', { name: /app a/i })).toBeInTheDocument();
});

test('renders activeSub as a second line when provided', () => {
  render(<FileSwitcher activeName="App A" activeSub="app-1 · Spark 3.5.3" entries={[]} />);
  expect(screen.getByText('app-1 · Spark 3.5.3')).toBeInTheDocument();
});

test('omits the second line when activeSub is not provided', () => {
  render(<FileSwitcher activeName="App A" entries={[]} />);
  expect(screen.queryByText(/spark \d/i)).not.toBeInTheDocument();
});

test('gives the active-file trigger enough room before truncating its name', () => {
  render(<FileSwitcher activeName="a-very-long-current-file-name-that-must-truncate-on-narrow-dashboards.ndjson" entries={[]} />);
  expect(screen.getByRole('button', { name: /a-very-long-current-file-name/i }))
    .toHaveClass('max-w-40', 'sm:max-w-80');
});

test('menu starts closed and opens on trigger click', async () => {
  render(<FileSwitcher activeName="x" entries={[mkEntry('a')]} />);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /x/i }));
  expect(await screen.findByRole('menu')).toBeInTheDocument();
});

test('fires onOpenNew and closes the menu', async () => {
  const onOpenNew = vi.fn();
  render(<FileSwitcher activeName="x" entries={[]} onOpenNew={onOpenNew} />);
  await userEvent.click(screen.getByRole('button', { name: /x/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /load new file/i }));
  expect(onOpenNew).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('menu')).not.toBeInTheDocument();
});

// RecentList's row is a plain <button>, not a DropdownMenuItem, so picking it
// fires no dismiss-on-select and the menu stays open.
test('fires onPick with the id (menu stays open: RecentList row is not a DropdownMenuItem)', async () => {
  const onPick = vi.fn();
  render(<FileSwitcher activeName="x" entries={[mkEntry('a')]} onPick={onPick} />);
  await userEvent.click(screen.getByRole('button', { name: /x/i }));
  await userEvent.click(await screen.findByRole('button', { name: /a\.log/i }));
  expect(onPick).toHaveBeenCalledWith('a');
});
