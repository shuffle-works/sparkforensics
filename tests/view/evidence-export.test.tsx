// @vitest-environment jsdom
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { toast } from 'sonner';
import { store, emptyAppModel } from '@/store/store';
import { EvidenceExport } from '@/view/EvidenceExport';
import { decodeRunPayload } from '@/export/hydrate-store';
import { EXPORT_TEMPLATE_FILE } from '@/export/single-file';
import * as reportBuilder from '@sparkforensics/core/evidence-report.ts';
import { buildHtmlExportData } from '@sparkforensics/core/html-export.ts';

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

// A stand-in for dist/export-template.html: the real one is only built by
// `npm run build`, and only the data.js tag matters to the splice.
const FAKE_TEMPLATE = '<!doctype html><html><body><div id="root"></div><script src="./data.js"></script><script type="module">/* app */</script></body></html>';

function stubTemplateFetch(body = FAKE_TEMPLATE, status = 200) {
  const fetchSpy = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

// Pulls the payload back out of the downloaded page, then decodes it exactly
// as the export app does at boot.
function payloadOf(html: string) {
  const match = html.match(/window\.__SPARKFORENSICS_RUN_GZ__ = "([^"]+)";/);
  if (!match) throw new Error('downloaded HTML carries no inline payload');
  return decodeRunPayload(match[1]);
}

async function downloadHtml({ redact = false } = {}) {
  render(<EvidenceExport />);
  await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
  if (redact) await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: /redact identifiers/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /download html dashboard/i }));
  await waitFor(() => expect(lastBlob).not.toBeNull());
  return blobText(lastBlob);
}

test('download HTML fetches the template on demand and inlines the run as one file', async () => {
  seedRun();
  const fetchSpy = stubTemplateFetch();
  const html = await downloadHtml();

  expect(fetchSpy).toHaveBeenCalledWith(EXPORT_TEMPLATE_FILE);
  expect(lastDownloadName).toBe('evidence-application_123.html');
  expect(lastBlob?.type).toBe('text/html');
  expect(html).not.toContain('src="./data.js"');
  expect(html).toContain('window.__SPARKFORENSICS_PUBLISHED_DOCS__ = true;');
  expect(html).toContain('<script type="module">/* app */</script>');
});

test('the payload spliced into the downloaded HTML decodes back to the same run data', async () => {
  seedRun();
  stubTemplateFetch();
  const s = store.getState();
  const expected = buildHtmlExportData(s.appModel, s.catalog, s.skippedLines, { redact: false });

  const decoded = payloadOf(await downloadHtml());

  expect(decoded).toEqual(expected);
  expect(decoded.app?.id).toBe('application_123');
});

test('the redact toggle reaches the HTML export: pseudonymized payload and filename', async () => {
  seedRun();
  stubTemplateFetch();
  const html = await downloadHtml({ redact: true });

  expect(lastDownloadName).toBe('evidence-app-1-redacted.html');
  expect(html).not.toContain('application_123');
  expect(payloadOf(html).app?.id).toBe('app-1');
});

test('a missing template surfaces an error instead of downloading a broken file', async () => {
  seedRun();
  stubTemplateFetch('not found', 404);
  const errorSpy = vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<EvidenceExport />);

  await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
  await userEvent.click(await screen.findByRole('menuitem', { name: /download html dashboard/i }));

  await waitFor(() => expect(errorSpy).toHaveBeenCalledWith('HTML export failed', expect.anything()));
  expect(lastBlob).toBeNull();
});

test('the export app itself does not offer the HTML download', async () => {
  seedRun();
  store.setState({ exportMode: true });
  try {
    render(<EvidenceExport />);
    await userEvent.click(screen.getByRole('button', { name: /export evidence/i }));
    expect(await screen.findByRole('menuitem', { name: /download json/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /download html/i })).toBeNull();
  } finally {
    store.setState({ exportMode: false });
  }
});
