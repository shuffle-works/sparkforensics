// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from '@/App';
import { store } from '@/store/store';

// CompareLanding renders a real DropZone, which reads recentFiles (indexedDB)
// on mount: stub it out for a deterministic render.
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
  store.getState().resetModel();
  store.setState({ sessionCache: new Map(), activeFileId: null });
});

test('compareLoad shows the sequential loading screen naming the current run', () => {
  store.setState({ compareLoad: { current: 2 }, status: 'parsing' });
  render(<App />);
  expect(screen.getByText(/parsing run 2 of 2/i)).toBeInTheDocument();
});

test('landing route renders the two-slot compare entry', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /compare two runs/i })).toBeInTheDocument();
});
