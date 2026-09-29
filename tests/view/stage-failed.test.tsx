// tests/view/stage-failed.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StageFailed } from '../../src/view/widgets/StageFailed';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { emptyAppModel } from '../../src/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { testFinding } from './_shared/finding';

function makeAppModel(stageNames: Record<number, string>): AppModel {
  const stages = new Map(Object.entries(stageNames).map(([id, name]) => [Number(id), { id: Number(id), name }]));
  return { ...emptyAppModel(), stages };
}

function render_(catalog: Finding[], appModel: AppModel = makeAppModel({ 1: 'scan', 3: 'aggregate' })) {
  return render(
    <StageDetailProvider>
      <StageFailed appModel={appModel} catalog={catalog} />
    </StageDetailProvider>,
  );
}

function stageFailedFinding(stageId: number, reason: string, recommendation: string, impactBand: Finding['impactBand'] = 'critical'): Finding {
  return testFinding({
    type: 'stageFailed', stageId, impactBand, variant: 'stageFailure',
    metric: 'stageFailureReason', valueText: reason,
    numTasks: 1, memoryBytesSpilled: 0, failedTaskDetails: [],
    recommendation,
  });
}

describe('StageFailed', () => {
  it('renders nothing when the catalog has no stageFailed findings', () => {
    const { container } = render_([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a stage-failed finding with the SFAIL tag and its failure reason', async () => {
    const user = userEvent.setup();
    const catalog = [
      stageFailedFinding(3, 'ExecutorLostFailure', 'Inspect the driver log for the failure reason.'),
    ];
    render_(catalog);
    expect(screen.getByRole('heading', { name: 'Failed Stages' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^failed stages$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 3/i })).toBeInTheDocument();
    expect(screen.getByText(/ExecutorLostFailure/)).toBeInTheDocument();
  });

  it('shows the SFAIL tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const catalog = [
      stageFailedFinding(1, 'ExecutorLostFailure', 'r1'),
      stageFailedFinding(3, 'FetchFailed', 'r3'),
    ];
    const { container } = render_(catalog);
    expect(screen.getByText('SFAIL')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('flags every affected stage, not just the worst', async () => {
    const user = userEvent.setup();
    const catalog = [
      stageFailedFinding(1, 'ExecutorLostFailure', 'r1'),
      stageFailedFinding(3, 'FetchFailed', 'r3'),
    ];
    render_(catalog);
    await user.click(screen.getByRole('button', { name: /^failed stages$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 3/i })).toBeInTheDocument();
  });

  it('shows the card\'s fix by default, with no per-row toggle', async () => {
    const catalog = [
      stageFailedFinding(3, 'ExecutorLostFailure', 'Inspect the driver log for the failure reason.'),
    ];
    render_(catalog);
    expect(screen.getByText('Inspect the driver log for the failure reason and the job that triggered it.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confidence|evidence|task detail/i })).not.toBeInTheDocument();
  });

  it('defaults the card collapsed, with a lead summary counting failed stages', () => {
    const catalog = [stageFailedFinding(3, 'ExecutorLostFailure', 'r')];
    render_(catalog);
    const cardButton = screen.getByRole('button', { name: 'Failed Stages' });
    expect(cardButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('stage failed outright')).toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) =>
      stageFailedFinding(i + 1, 'ExecutorLostFailure', `r${i}`),
    );
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    render_(catalog, makeAppModel(stageNames));
    await user.click(screen.getByRole('button', { name: 'Failed Stages' }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time, resetting to page 1 on a fresh appModel', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) =>
      stageFailedFinding(i + 1, 'ExecutorLostFailure', `r${i}`),
    );
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    const { rerender } = render_(catalog, makeAppModel(stageNames));

    await user.click(screen.getByRole('button', { name: 'Failed Stages' }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    rerender(
      <StageDetailProvider>
        <StageFailed appModel={makeAppModel(stageNames)} catalog={catalog} />
      </StageDetailProvider>,
    );
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });
});
