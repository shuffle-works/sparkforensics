// @vitest-environment jsdom
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { store, emptyAppModel } from '@/store/store';
import { analyze, auditConfig } from '@sparkforensics/core/analyzer.ts';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';

const ROOT = join(__dirname, '..', '..');
const FIXTURE_DIR = join(ROOT, 'packages', 'core', 'test', 'fixtures');
const LOGS = [
  join(ROOT, 'public', 'sample-runs', 'sample-run.ndjson.gz'),
  ...readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.ndjson')).map((name) => join(FIXTURE_DIR, name)),
];

/** What a panel shows besides its title and what names the finding (its stage chip, stage name and
 * call site): text, or a chart or table. */
function panelBody(panel: HTMLElement): { text: string; hasVisual: boolean } {
  const clone = panel.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('h3, [data-panel-identity], button[aria-label^="Open details for Stage"]').forEach((node) => node.remove());
  return {
    text: clone.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    hasVisual: clone.querySelector('svg:not([aria-hidden="true"]), table, canvas, img') != null,
  };
}

const VIEWS = [
  { name: 'default view', search: '' },
  { name: 'info shown', search: '?impact=critical,warning,info' },
];

describe('every opened evidence panel shows evidence', () => {
  it.each(LOGS.flatMap((path) => VIEWS.map((view) => [path, view.name, view.search] as const)))('%s (%s)', async (path, _name, search) => {
    window.history.replaceState({}, '', `/${search}`);
    const { appModel } = await collectRun(path);
    const catalog = analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates);
    store.setState({ ...emptyAppModel(), appModel, catalog, configFindings: auditConfig(appModel.app, appModel.stages), status: 'ready', widgetDensity: 'basic' } as never);

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('tab', { name: 'Findings' });

    const empty: string[] = [];
    const opened = new Set<string>();
    // Each click opens one panel and may unmount the button it came from, so look the buttons up again.
    for (;;) {
      const button = screen.queryAllByRole('button', { name: 'Show evidence' }).find((candidate) => candidate.getAttribute('aria-expanded') === 'false');
      if (!button) break;
      const panelId = button.getAttribute('aria-controls')!;
      await user.click(button);
      await waitFor(() => expect(document.getElementById(panelId)?.querySelector('h3')).not.toBeNull());
      const panel = document.getElementById(panelId)!;
      opened.add(panelId);
      const body = panelBody(panel);
      if (body.text === '' && !body.hasVisual) empty.push(`${panelId} (${panel.querySelector('h3')!.textContent})`);
    }

    if (path.endsWith('.ndjson.gz')) expect(opened.size).toBeGreaterThan(0);
    expect(empty).toEqual([]);
  }, 60_000);
});
