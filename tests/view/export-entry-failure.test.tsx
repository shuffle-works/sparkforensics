// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { RUN_PAYLOAD_GLOBAL } from '@sparkforensics/core/run-payload.ts';

// The export entry runs at import time, so each test sets up the page, then imports it fresh.
vi.mock('@/store/useIngest', async () => {
  const stub = await import('@/export/live-only-stubs/useIngest');
  return { useIngest: stub.useIngest };
});
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

beforeEach(() => {
  vi.resetModules();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  document.body.innerHTML = '<div id="root"></div>';
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)[RUN_PAYLOAD_GLOBAL];
  vi.restoreAllMocks();
});

test('an export opened without its data.js shows the unsupported-payload view, not a blank page', async () => {
  delete (window as unknown as Record<string, unknown>)[RUN_PAYLOAD_GLOBAL];
  await import('@/export/main-export');

  expect(await screen.findByText("This dashboard can't be shown")).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('data.js');
});

test('an export with a truncated data.js shows the unsupported-payload view', async () => {
  (window as unknown as Record<string, unknown>)[RUN_PAYLOAD_GLOBAL] = 'H4sIAAAAAAAA';
  await import('@/export/main-export');

  expect(await screen.findByText("This dashboard can't be shown")).toBeInTheDocument();
});
