// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memo } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Finding, TaskData } from '@sparkforensics/core/types.ts';

import { REGISTRY, type WidgetProps } from '@/view/detector-registry';
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

const originalShuffleComponent = REGISTRY.shuffle.component;
afterEach(() => {
  REGISTRY.shuffle.component = originalShuffleComponent;
});

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

  it('gives each row of a type its own panel', async () => {
    const resourceOnly = { basis: 'resourceOnly', wallClock: null, rawWaste: { value: 500, unit: 'ms' }, estimateMethod: 'measured' } as const;
    const first = testFinding({
      type: 'shuffle', id: 'shuffle-1', stageId: 1, impactBand: 'warning', value: 286 * 1024 * 1024,
      recommendation: '286 MB shuffled in this stage.', impactEstimate: estimate,
    });
    const second = testFinding({
      type: 'shuffle', id: 'shuffle-2', stageId: 1, impactBand: 'warning', value: 100 * 1024 * 1024,
      recommendation: '100 MB shuffled in this stage.', impactEstimate: resourceOnly,
    });
    const onRoute = renderBoard([first, second]);
    const buttons = screen.getAllByRole('button', { name: 'Show evidence' });
    expect(buttons).toHaveLength(2);

    await userEvent.click(buttons[0]);
    await userEvent.click(buttons[1]);

    expect(onRoute).not.toHaveBeenCalled();
    expect(await screen.findAllByRole('heading', { name: 'Shuffle I/O' })).toHaveLength(2);
    expect(document.getElementById('finding-evidence-shuffle-1')).not.toBeNull();
    expect(document.getElementById('finding-evidence-shuffle-2')).not.toBeNull();
  });

  it('opens the measurements behind a figure the row already states, in place and without routing', async () => {
    const utilization = testFinding({
      type: 'utilization', id: 'utilization-1', stageId: null, impactBand: 'warning', metric: 'avgUtilization', value: 33,
      recommendation: 'Average executor utilization was only 33%.', utilizationFraction: 0.33, appDurationMs: 60_000, totalCores: 4, allocatedCoreMs: 240_000, cpuUtilizationPct: 33,
    });
    const onRoute = renderBoard([utilization]);
    const button = screen.getByRole('button', { name: 'Show evidence' });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(button);
    expect(onRoute).not.toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const table = within(screen.getByRole('table'));
    expect(await table.findByRole('heading', { name: 'Executor Utilization' })).toBeInTheDocument();
    expect(table.getByText(/4 cores at peak over 1m 0s: 240\.0 core-s allocated, 79\.2 core-s busy, 160\.8 core-s idle\. CPU time was 33% of the allocation\./)).toBeInTheDocument();
  });

  it('keeps an open panel\'s widget props when the board re-renders with the same inputs', async () => {
    const renders = vi.fn();
    REGISTRY.shuffle.component = memo(function CountingShuffle({ catalog }: WidgetProps) {
      renders(catalog);
      return <h3>Shuffle I/O</h3>;
    });
    const shuffle = testFinding({
      type: 'shuffle', id: 'shuffle-1', stageId: 1, impactBand: 'warning', value: 286 * 1024 * 1024,
      recommendation: '286 MB shuffled in this stage.', impactEstimate: estimate,
    });
    const model = appModel();
    installInterpretation([shuffle], model as never);
    const getTaskData = async () => ({ taskEvents: [] }) as unknown as TaskData;
    const catalog = [shuffle];
    const configFindings: Finding[] = [];
    const onRoute = vi.fn();
    const board = () => (
      <StageDetailProvider>
        <ImpactBoard appModel={model as never} catalog={catalog} configFindings={configFindings} stages={model.stages as never} getTaskData={getTaskData} onRoute={onRoute} />
      </StageDetailProvider>
    );
    const { rerender } = render(board());
    await userEvent.click(screen.getByRole('button', { name: 'Show evidence' }));
    await screen.findByRole('heading', { name: 'Shuffle I/O' });
    const rendersBefore = renders.mock.calls.length;

    rerender(board());

    expect(renders).toHaveBeenCalledTimes(rendersBefore);
  });
});
