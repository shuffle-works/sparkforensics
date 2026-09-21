// @vitest-environment jsdom
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { store, emptyAppModel } from '@/store/store';
import { EvidenceExport } from '@/view/EvidenceExport';
import * as reportBuilder from '@sparkforensics/core/evidence-report.ts';

function seedRun() {
  store.setState({
    appModel: {
      ...emptyAppModel(),
      app: { id: 'application_123', name: 'demo', startTime: 0, endTime: 5000, sparkVersion: '3.4.0', config: {} },
    },
  });
}

// Capture the actual Blob + filename so a swapped MD/JSON branch or bad filename can't slip by.
let lastBlob: Blob | null;
let lastDownloadName: string | null;

beforeEach(() => {
  store.setState({ ...store.getState(), appModel: emptyAppModel() });
  lastBlob = null;
  lastDownloadName = null;
  // jsdom has no object-URL / blob-download plumbing; capture the Blob here.
  (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b: Blob) => {
    lastBlob = b;
    return 'blob:mock';
  };
  (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
  // Prevent jsdom "Not implemented: navigation" noise; record the filename.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    lastDownloadName = this.download;
  });
});

afterEach(() => vi.restoreAllMocks());

async function blobText(blob: Blob | null): Promise<string> {
  return blob ? blob.text() : '';
}

test('renders an Export evidence control', () => {
  seedRun();
  render(<EvidenceExport />);
  expect(screen.getByRole('button', { name: /export evidence/i })).toBeInTheDocument();
});

test('download JSON writes parseable JSON to a run-named file', async () => {
  seedRun();
  const spy = vi.spyOn(reportBuilder, 'buildEvidenceReport');
  render(<EvidenceExport />);

  await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /download json/i }));

  expect(spy).toHaveBeenCalledWith(expect.anything(), { redact: false });
  expect(lastDownloadName).toBe('evidence-application_123.json');
  const parsed = JSON.parse(await blobText(lastBlob));
  expect(parsed.summary.app.id).toBe('application_123');
});

test('download Markdown writes the markdown text (not the JSON) to an .md file', async () => {
  seedRun();
  render(<EvidenceExport />);

  await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /download markdown/i }));

  expect(lastDownloadName).toBe('evidence-application_123.md');
  const text = await blobText(lastBlob);
  expect(text.startsWith('# Spark run evidence report')).toBe(true);
  expect(() => JSON.parse(text)).toThrow(); // proves it is markdown, not JSON
});

test('the redact toggle flips the builder option and marks the filename', async () => {
  seedRun();
  const spy = vi.spyOn(reportBuilder, 'buildEvidenceReport');
  render(<EvidenceExport />);

  await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
  await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /redact identifiers/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /download markdown/i }));

  expect(spy).toHaveBeenCalledWith(expect.anything(), { redact: true });
  // Redacted export: real app id never appears in the name; -redacted marker on.
  expect(lastDownloadName).toBe('evidence-app-1-redacted.md');
  expect(lastDownloadName).not.toContain('application_123');
});
