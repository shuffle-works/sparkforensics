// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Finding, TaskData } from '@sparkforensics/core/types.ts';

import { StageDetailProvider } from '@/view/StageDetailContext';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { emptyAppModel } from '@/store/store';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

function appModel() {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 60_000 },
    stages: new Map([[1, { id: 1, submittedAt: 0, completedAt: 1000, name: 'collect at Job.scala:12', shuffleWriteBytes: 5 * 1024 * 1024 }]]),
  };
}

function renderBoard(catalog: Finding[], onRoute = vi.fn()) {
  installInterpretation(catalog, appModel() as never);
  render(
    <StageDetailProvider>
      <ImpactBoard
        appModel={appModel() as never}
        catalog={catalog}
        configFindings={[]}
        stages={appModel().stages as never}
        getTaskData={async () => ({ taskEvents: [] }) as unknown as TaskData}
        onRoute={onRoute}
      />
    </StageDetailProvider>,
  );
  return onRoute;
}

const estimate = { basis: 'serial', wallClock: { low: 675, high: 675 }, estimateMethod: 'measured', rawWaste: { value: 675, unit: 'ms' } } as const;

describe('evidence panel on a Findings row', () => {
  it('starts at the finding text column, under a flat heading, without what the row already shows', async () => {
    const shuffle = testFinding({
      type: 'shuffle', id: 'shuffle-1', stageId: 1, impactBand: 'warning', value: 286 * 1024 * 1024,
      recommendation: '286 MB shuffled in this stage.', impactEstimate: estimate,
    });
    renderBoard([shuffle]);
    await userEvent.click(screen.getByRole('button', { name: 'Show evidence' }));

    const heading = await screen.findByRole('heading', { name: 'Shuffle I/O' });
    const panelRow = heading.closest('tr') as HTMLElement;
    const cells = within(panelRow).getAllByRole('cell');
    expect(cells).toHaveLength(2);
    expect(cells[0]).toHaveClass('w-px');
    expect(cells[1]).toHaveAttribute('colspan', '2');
    // A wide table or chart in the panel scrolls inside it instead of stretching the row.
    expect(panelRow.querySelector('#finding-evidence-shuffle-1')).toHaveClass('w-0', 'min-w-full');

    // The row carries the stage chip, the shuffle size and the savings; the panel keeps only what is new.
    expect(within(panelRow).queryByText('Potential savings:')).not.toBeInTheDocument();
    expect(within(panelRow).queryByText(/Shuffle read:/)).not.toBeInTheDocument();
    expect(within(panelRow).queryByRole('button', { name: 'Stage 1' })).not.toBeInTheDocument();
    expect(within(panelRow).getByText('collect at Job.scala:12')).toBeInTheDocument();
    expect(within(panelRow).getByText(/Write:/)).toBeInTheDocument();
    expect(within(panelRow).queryByText('SHFL')).not.toBeInTheDocument();
  });

  it('routes to the grid card, with no panel, when the row states everything its widget shows', async () => {
    const utilization = testFinding({
      type: 'utilization', id: 'utilization-1', stageId: null, impactBand: 'warning', metric: 'avgUtilization', value: 33,
      recommendation: 'Average executor utilization was only 33%.', utilizationFraction: 0.33, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 33,
    });
    const onRoute = renderBoard([utilization]);
    const button = screen.getByRole('button', { name: 'Show evidence' });
    expect(button).not.toHaveAttribute('aria-expanded');

    await userEvent.click(button);
    expect(onRoute).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('table')).queryByRole('heading')).not.toBeInTheDocument();
  });
});
