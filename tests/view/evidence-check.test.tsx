// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { store } from '@/store/store';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { registryTypes } from '@/view/detector-registry';
import { evidencePanelOf, InlineEvidence } from '@/view/InlineEvidence';
import { computeActiveWidgets } from '@/view/widgets/Alerts';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { showsEvidence } from './_shared/evidence-panel';
import { installInterpretation } from './_shared/interpretation';
import { exampleRuns, loadExampleRun } from './_shared/detector-examples';

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

beforeEach(() => store.getState().resetModel());
afterEach(() => {
  cleanup();
  store.setState({ widgetDensity: 'basic' });
});

// A widget renders only the rows its content check keeps, so a panel exists exactly when the check
// keeps a row. What can still drift is a kept row that renders nothing under its title (a widget
// that leaves out more than its check does), which would show an evidence control that opens an
// empty panel. This fails for it, in both densities, with and without the finding stated above, for
// every finding of every example run. Output that is hidden counts as not shown.
test.each(exampleRuns())('%s: every panel a content check keeps renders evidence', async (log) => {
  expect(loadExampleRun(log)).toBeNull();
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

// The other direction: a Findings row offers its evidence control exactly when the check keeps a
// row. A row whose check keeps nothing shows no control, hidden or not.
const typesWithRow = new Set<string>();
// The board leaves out a finding that is only a note about the log, so it has no row to look at.
const TYPES_WITHOUT_ROW = ['incompleteRun'];

test.each(exampleRuns())('%s: a row offers the evidence control exactly when its content check keeps a row', async (log) => {
  expect(loadExampleRun(log)).toBeNull();
  const { appModel, catalog, configFindings } = store.getState();
  const wrong: string[] = [];

  for (const finding of [...catalog, ...configFindings]) {
    // One finding on its own board: a step or a row states its own finding.
    const rowCatalog = configFindings.includes(finding) ? [] : [finding];
    const rowConfig = configFindings.includes(finding) ? [finding] : [];
    installInterpretation(rowCatalog, appModel, rowConfig);
    const widget = computeActiveWidgets(rowCatalog, rowConfig, store.getState().interpretation!.data.detectors)[0];
    for (const density of ['basic', 'advanced'] as const) {
      store.setState({ widgetDensity: density });
      const expected = evidencePanelOf(widget, appModel, [finding], [finding], density) !== null;
      const { unmount } = render(
        <StageDetailProvider>
          <ImpactBoard appModel={appModel} catalog={rowCatalog} configFindings={rowConfig} stages={appModel.stages} getTaskData={vi.fn()} onRoute={vi.fn()} />
        </StageDetailProvider>,
      );
      if (screen.queryAllByTestId('fix-these-first-row').length > 0) {
        typesWithRow.add(finding.type);
        const offered = screen.queryAllByRole('button', { name: /^(Show|Hide) evidence$/ }).some((button) => button.hasAttribute('aria-controls'));
        if (offered !== expected) wrong.push(`${finding.type} ${finding.id} (${density}): the check keeps ${expected ? 'a row' : 'no row'}, the row ${offered ? 'offers an' : 'offers no'} evidence control`);
      }
      unmount();
    }
  }
  expect(wrong).toEqual([]);
}, 120_000);

// Guards the test above against passing without comparing a type.
test('every finding type has a row in some example run', () => {
  expect(registryTypes().filter((type) => !typesWithRow.has(type) && !TYPES_WITHOUT_ROW.includes(type))).toEqual([]);
});
