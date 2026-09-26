// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ImpactBoard } from '../../src/view/widgets/ImpactBoard';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { emptyAppModel, store } from '../../src/store/store';
import type { Finding, TaskData } from '@sparkforensics/core/types.ts';
import type { TriageTarget } from '../../src/view/triage-target';

function readyAppModel() {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    stages: new Map([[1, { id: 1, submittedAt: 0, completedAt: 1000 }], [2, { id: 2, submittedAt: 1000, completedAt: 2000 }]]),
  };
}

const getTaskData = vi.fn(async (): Promise<TaskData> => ({ taskEvents: [] }) as unknown as TaskData);

function skewFinding(stageId: number, impactBand: Finding['impactBand']): Finding {
  return { type: 'skew', stageId, impactBand, metric: 'p95Median', value: 5, recommendation: `Rebalance Stage ${stageId}.` } as Finding;
}
function gcFinding(stageId: number, impactBand: Finding['impactBand']): Finding {
  return { type: 'gc', stageId, impactBand, direction: 'high', value: 15, recommendation: `Investigate GC in Stage ${stageId}.` } as Finding;
}
// shuffle and partitionSizing share the ShuffleIO widget, the pairing this guards against.
function shuffleFinding(stageId: number, impactBand: Finding['impactBand']): Finding {
  return { type: 'shuffle', stageId, impactBand, value: 600 * 1024 * 1024, recommendation: `Reduce shuffle in Stage ${stageId}.` } as Finding;
}
function partitionSizingFinding(stageId: number, impactBand: Finding['impactBand']): Finding {
  return { type: 'partitionSizing', stageId, impactBand, recommendation: `Repartition Stage ${stageId}.` } as Finding;
}

function renderBoard(catalog: Finding[]) {
  return render(
    <StageDetailProvider>
      <ImpactBoard
        appModel={readyAppModel() as any}
        catalog={catalog}
        configFindings={[]}
        stages={readyAppModel().stages as any}
        getTaskData={getTaskData}
        onRoute={(_target: TriageTarget) => {}}
      />
    </StageDetailProvider>,
  );
}

describe('ImpactBoard', () => {
  // Card placement is the same in both views; Advanced view mounts every
  // band's cards, where Basic view folds them (see the Basic view describe).
  beforeEach(() => store.setState({ widgetDensity: 'advanced' }));
  afterEach(() => store.setState({ widgetDensity: 'basic' }));

  it('renders a Warning heading with the warning row and a matching active widget card, and an Info heading separately', async () => {
    renderBoard([skewFinding(1, 'warning'), gcFinding(2, 'info')]);

    const warningSection = screen.getByRole('heading', { name: 'Warning' }).closest('section') as HTMLElement;
    expect(within(within(warningSection).getByRole('table')).getByText('Rebalance Stage 1.')).toBeInTheDocument();
    expect(await within(warningSection).findByRole('heading', { name: 'Task Skew' })).toBeInTheDocument();

    const infoSection = screen.getByRole('heading', { name: 'Info' }).closest('section') as HTMLElement;
    expect(within(within(infoSection).getByRole('table')).getByText('Investigate GC in Stage 2.')).toBeInTheDocument();
    expect(await within(infoSection).findByRole('heading', { name: 'GC Pressure' })).toBeInTheDocument();
  });

  it('renders no Critical heading when no finding is critical', () => {
    renderBoard([skewFinding(1, 'warning')]);
    expect(screen.queryByRole('heading', { name: 'Critical' })).not.toBeInTheDocument();
  });

  it('a clean catalog shows no impact-band headings, but keeps the always-visible grid', async () => {
    // The clean-run message belongs to RunVerdict above the tabs, not the board.
    renderBoard([]);
    expect(screen.queryByText('No findings to fix right now.')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Warning' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Core Usage by Locality' })).toBeInTheDocument();
  });

  it('keeps a row in its own impact band even when it shares a widget card with a worse-band finding of another type', async () => {
    // Both render through one ShuffleIO card, but each row stays in its own finding's real band.
    renderBoard([shuffleFinding(1, 'critical'), partitionSizingFinding(2, 'info')]);

    const criticalSection = screen.getByRole('heading', { name: 'Critical' }).closest('section') as HTMLElement;
    const criticalTable = within(criticalSection).getByRole('table');
    expect(within(criticalTable).getByText('Reduce shuffle in Stage 1.')).toBeInTheDocument();
    expect(await within(criticalSection).findByRole('heading', { name: 'Shuffle I/O' })).toBeInTheDocument();

    const infoSection = screen.getByRole('heading', { name: 'Info' }).closest('section') as HTMLElement;
    const infoTable = within(infoSection).getByRole('table');
    expect(within(infoTable).getByText('Repartition Stage 2.')).toBeInTheDocument();

    expect(screen.queryByText(/its own impact band is/)).not.toBeInTheDocument();

    // Only one Shuffle I/O card renders, in Critical (its worst-band finding), not one per band.
    expect(screen.getAllByRole('heading', { name: 'Shuffle I/O' })).toHaveLength(1);
  });
});

describe('ImpactBoard in Basic view', () => {
  it('leads each band with its rows and folds that band\'s evidence cards until asked', async () => {
    const user = userEvent.setup();
    renderBoard([skewFinding(1, 'warning'), gcFinding(2, 'info')]);

    const warningSection = screen.getByRole('heading', { name: 'Warning' }).closest('section') as HTMLElement;
    expect(within(warningSection).getByText('Rebalance Stage 1.')).toBeInTheDocument();
    expect(within(warningSection).queryByRole('heading', { name: 'Task Skew' })).not.toBeInTheDocument();

    await user.click(within(warningSection).getByRole('button', { name: 'Show the evidence (1 card)' }));
    expect(await within(warningSection).findByRole('heading', { name: 'Task Skew' })).toBeInTheDocument();
    // Opening one band leaves the others folded.
    const infoSection = screen.getByRole('heading', { name: 'Info' }).closest('section') as HTMLElement;
    expect(within(infoSection).getByRole('button', { name: 'Show the evidence (1 card)' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('ImpactBoard widget grid', () => {
  it('passes defaultCollapsed to Widget components in the "other findings" grid', () => {
    // Source-inspection, mirroring Alerts.tsx's equivalent check: the always-mounted
    // reference grid and this ImpactGroup grid both start their cards collapsed.
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '../../src/view/widgets/ImpactBoard.tsx'), 'utf-8');
    expect(source).toContain('defaultCollapsed />');
  });
});
