// @vitest-environment jsdom
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import App from '@/App';
import { store, emptyAppModel } from '@/store/store';
import { isBlankPanelBody } from '@/view/panel-body';
import { analyze, auditConfig } from '@sparkforensics/core/analyzer.ts';
import { collectRun } from '@sparkforensics/core/cli/collect-run.ts';

const SYNTHETIC_DIR = join(__dirname, '..', '..', 'packages', 'core', 'test', 'fixtures', 'synthetic');
const EVIDENCE_TOGGLE = /^(Show|Hide) evidence$/;

// Each of these logs has a verdict step or Findings row whose line states its finding in full, so
// every row of the finding's card leaves out what it repeats.
describe('an evidence panel with nothing to show beyond its line is not offered', () => {
  it.each([
    ['over-broadcast', '[data-testid="next-step"]'],
    ['python-udf', '[data-testid="next-step"]'],
    ['right-sizing', '[data-testid="fix-these-first-row"][data-finding-type="rightSizing"]'],
  ])('%s', async (name, holderSelector) => {
    window.history.replaceState({}, '', '/?impact=critical,warning,info');
    const { appModel } = await collectRun(join(SYNTHETIC_DIR, `${name}.ndjson`));
    const catalog = analyze(appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed, appModel.jobs, appModel.sql, appModel.runAggregates);
    store.setState({ ...emptyAppModel(), appModel, catalog, configFindings: auditConfig(appModel.app, appModel.stages), status: 'ready', widgetDensity: 'basic' } as never);

    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole('tab', { name: 'Findings' });

    // The step or row with the blank panel offers no evidence toggle once the panel has rendered.
    await waitFor(() => {
      const holders = [...document.querySelectorAll<HTMLElement>(holderSelector)];
      expect(holders.some((holder) => within(holder).queryByRole('button', { name: EVIDENCE_TOGGLE }) === null)).toBe(true);
    });

    // Every toggle still offered opens a panel with evidence in it.
    const panelIds: string[] = [];
    for (;;) {
      const button = screen.queryAllByRole('button', { name: 'Show evidence' }).find((candidate) => candidate.getAttribute('aria-expanded') === 'false');
      if (!button) break;
      const panelId = button.getAttribute('aria-controls')!;
      await user.click(button);
      await waitFor(() => expect(document.getElementById(panelId)?.querySelector('h3')).not.toBeNull());
      panelIds.push(panelId);
    }
    for (const panelId of panelIds) {
      const panel = document.getElementById(panelId)!;
      const section = panel.querySelector('section')!;
      expect(isBlankPanelBody(section.lastElementChild as HTMLElement)).toBe(false);
      expect(panel.closest('[hidden]')).toBeNull();
    }
  }, 60_000);
});
