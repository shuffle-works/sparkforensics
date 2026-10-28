// @vitest-environment jsdom
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { store, emptyAppModel } from '@/store/store';
import { isBlankPanelBody } from '@/view/panel-body';
import { analyze, auditConfig } from '@sparkforensics/core/analyzer.ts';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';

const SYNTHETIC_DIR = join(__dirname, '..', '..', 'packages', 'core', 'test', 'fixtures', 'synthetic');

// Each of these logs has a finding the line above its evidence panel states in full, so every row
// of the finding's card leaves out what it repeats.
describe('an evidence panel with nothing to show beyond its line is not shown', () => {
  it.each(['over-broadcast', 'python-udf', 'right-sizing'])('%s', async (name) => {
    window.history.replaceState({}, '', '/?impact=critical,warning,info');
    const { appModel } = await collectRun(join(SYNTHETIC_DIR, `${name}.ndjson`));
    const catalog = analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates);
    store.setState({ ...emptyAppModel(), appModel, catalog, configFindings: auditConfig(appModel.app, appModel.stages), status: 'ready', widgetDensity: 'basic' } as never);

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('tab', { name: 'Findings' });

    const panelIds: string[] = [];
    for (;;) {
      const button = screen.queryAllByRole('button', { name: 'Show evidence' }).find((candidate) => candidate.getAttribute('aria-expanded') === 'false');
      if (!button) break;
      const panelId = button.getAttribute('aria-controls')!;
      await user.click(button);
      await waitFor(() => expect(document.getElementById(panelId)?.querySelector('h3')).not.toBeNull());
      panelIds.push(panelId);
    }

    expect(panelIds.length).toBeGreaterThan(0);
    const blank = panelIds.map((id) => document.getElementById(id)!.querySelector('section')!).filter((section) => isBlankPanelBody(section.lastElementChild as HTMLElement));
    expect(blank.length).toBeGreaterThan(0);
    // A blank panel keeps no title on screen: its section is hidden. Any other panel stays shown.
    for (const section of blank) expect(section).toHaveAttribute('hidden');
    const shown = panelIds.map((id) => document.getElementById(id)!.querySelector('section')!).filter((section) => !blank.includes(section));
    for (const section of shown) expect(section).not.toHaveAttribute('hidden');
  }, 60_000);
});
