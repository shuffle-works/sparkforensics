// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { loadExportPayload } from '@/export/hydrate-store';
import { store } from '@/store/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { InlineEvidence, widgetHasEvidence } from '@/view/InlineEvidence';
import { computeActiveWidgets } from '@/view/widgets/Alerts';

// The same swaps vite.export.config.ts makes (LIVE_ONLY_STUBS): the runs are the HTML export's.
vi.mock('@/store/useIngest', () => import('@/export/live-only-stubs/useIngest'));
vi.mock('@/view/useRecentFiles', () => import('@/export/live-only-stubs/useRecentFiles'));
vi.mock('@/view/EvidenceExport', () => import('@/export/live-only-stubs/EvidenceExport'));
vi.mock('@/view/core-usage-histogram-data', () => import('@/export/live-only-stubs/core-usage-histogram-data'));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const devDir = join(import.meta.dirname, '..', '..', 'dev');
const examples: Record<string, { source: string; log: string } | null> = JSON.parse(readFileSync(join(devDir, 'detector-examples.json'), 'utf8'));
const runs: Record<string, string> = JSON.parse(readFileSync(join(devDir, 'detector-example-runs.json'), 'utf8'));
const logs = [...new Set(Object.values(examples).flatMap((example) => (example ? [`${example.source}/${example.log}`] : [])))].sort();

beforeEach(() => store.getState().resetModel());
afterEach(() => {
  cleanup();
  store.setState({ widgetDensity: 'basic' });
});

// What an evidence panel shows besides its title: text, or a chart or a table.
function showsEvidence(panel: HTMLElement): boolean {
  const body = panel.querySelector('section > div:last-child') as HTMLElement;
  return Boolean(body.textContent?.trim()) || body.querySelector('svg:not([aria-hidden="true"]), table, canvas, img') != null;
}

// A widget's evidence check and what its panel renders are two reads of one row rule: a panel the
// check calls empty renders nothing under its title, and any other renders evidence. A check that
// drifts from its widget fails here, in both densities, for every finding of every example run.
test.each(logs)('%s: the evidence check matches what each finding\'s panel renders', async (log) => {
  expect(loadExportPayload(runs[log])).toBeNull();
  const { appModel, catalog, configFindings, interpretation } = store.getState();
  const widgets = computeActiveWidgets(catalog, configFindings, interpretation!.data.detectors);
  const widgetProps = { appModel, catalog, configFindings, getTaskData: vi.fn(), activeFileId: null };
  const disagreements: string[] = [];

  for (const widget of widgets) {
    for (const finding of widget.findings) {
      for (const density of ['basic', 'advanced'] as const) {
        store.setState({ widgetDensity: density });
        // A step or a row states its own finding; a group row states none.
        for (const stated of [[finding], []]) {
          const expected = widgetHasEvidence(widget, appModel, [finding], stated, density === 'advanced');
          const { container, unmount } = render(
            <ThemeProvider>
              <DocsProvider>
                <StageDetailProvider>
                  <EvidenceAvailabilityProvider>
                    <InlineEvidence widget={widget} widgetProps={widgetProps} stated={stated} scope={[finding]} />
                  </EvidenceAvailabilityProvider>
                </StageDetailProvider>
              </DocsProvider>
            </ThemeProvider>,
          );
          await waitFor(() => expect(container.querySelector('section h3')).not.toBeNull());
          if (showsEvidence(container) !== expected) {
            disagreements.push(`${finding.type} ${finding.id} (${density}, ${stated.length ? 'stated' : 'unstated'}): check ${expected}, panel ${!expected}`);
          }
          unmount();
        }
      }
    }
  }
  expect(disagreements).toEqual([]);
}, 120_000);
