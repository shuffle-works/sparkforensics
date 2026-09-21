// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RecentList, type RecentFileEntry } from '@/view/RecentList';

function mkEntry(id: string, over: Partial<RecentFileEntry> = {}): RecentFileEntry {
  return {
    id,
    name: `${id}.log`,
    size: 76_000_000,
    lastModified: 1,
    appName: null,
    issueCount: null,
    handle: {} as FileSystemFileHandle,
    lastOpenedAt: 1,
    ...over,
  };
}

test('shows an empty state when there are no entries', () => {
  render(<RecentList entries={[]} />);
  expect(screen.getByText(/no recent files yet/i)).toBeInTheDocument();
});

test('renders one row per entry with name and meta', () => {
  render(<RecentList entries={[mkEntry('a', { appName: 'App A', issueCount: 3 })]} />);
  expect(screen.getByText('App A')).toBeInTheDocument();
  const meta = screen.getByText(/a\.log/);
  expect(meta.textContent).toContain('a.log');
  expect(meta.textContent).toContain('76 MB');
  expect(meta.textContent).toContain('3 issues');
});

test('marks the active entry', () => {
  render(<RecentList entries={[mkEntry('a'), mkEntry('b')]} activeId="b" />);
  const items = screen.getAllByRole('listitem');
  expect(items).toHaveLength(2);
  expect(items[0].className).not.toMatch(/bg-accent/);
  expect(items[1].className).toMatch(/bg-accent/);
});

test('fires onPick with the entry id', async () => {
  const onPick = vi.fn();
  render(<RecentList entries={[mkEntry('a')]} onPick={onPick} />);
  await userEvent.click(screen.getByRole('button', { name: /a\.log/ }));
  expect(onPick).toHaveBeenCalledWith('a');
});

test('fires onRemove with the entry id', async () => {
  const onRemove = vi.fn();
  render(<RecentList entries={[mkEntry('a')]} onRemove={onRemove} />);
  await userEvent.click(screen.getByRole('button', { name: /remove from recent files/i }));
  expect(onRemove).toHaveBeenCalledWith('a');
});
