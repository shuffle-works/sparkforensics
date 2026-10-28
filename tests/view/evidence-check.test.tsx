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
import { evidencePanelOf, InlineEvidence } from '@/view/InlineEvidence';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { showsEvidence } from './_shared/evidence-panel';

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

// A widget renders only the rows its content check keeps, so a panel exists exactly when the check
// keeps a row. What can still drift is a kept row that renders nothing under its title (a widget
// that leaves out more than its check does), which would show an evidence control that opens an
// empty panel. This fails for it, in both densities, for every finding of every example run.
test.each(logs)('%s: every panel a content check keeps renders evidence', async (log) => {
  expect(loadExportPayload(runs[log])).toBeNull();
  const { appModel, catalog, configFindings, interpretation } = store.getState();
  const widgets = computeActiveWidgets(catalog, configFindings, interpretation!.data.detectors);
  const widgetProps = { appModel, catalog, configFindings, getTaskData: vi.fn(), activeFileId: null };
  const empty: string[] = [];

  for (const widget of widgets) {
    for (const finding of widget.findings) {
      for (const density of ['basic', 'advanced'] as const) {
        store.setState({ widgetDensity: density });
        // A step or a row states its own finding; a group row states none.
        for (const stated of [[finding], []]) {
          const panel = evidencePanelOf(widget, appModel, [finding], stated, density);
          // No panel: nothing renders, and the host offers no evidence control.
          if (!panel) continue;
          const { container, unmount } = render(
            <ThemeProvider>
              <DocsProvider>
                <StageDetailProvider>
                  <EvidenceAvailabilityProvider>
                    <InlineEvidence widget={widget} widgetProps={widgetProps} stated={stated} panel={panel} />
                  </EvidenceAvailabilityProvider>
                </StageDetailProvider>
              </DocsProvider>
            </ThemeProvider>,
          );
          await waitFor(() => expect(container.querySelector('section h3')).not.toBeNull());
          if (!showsEvidence(container)) empty.push(`${finding.type} ${finding.id} (${density}, ${stated.length ? 'stated' : 'unstated'})`);
          unmount();
        }
      }
    }
  }
  expect(empty).toEqual([]);
}, 120_000);
