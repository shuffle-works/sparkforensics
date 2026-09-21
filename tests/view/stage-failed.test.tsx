// tests/view/stage-failed.test.tsx
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { StageFailed } from '../../src/view/widgets/StageFailed';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { emptyAppModel } from '../../src/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

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

describe('StageFailed', () => {
  it('renders nothing when the catalog has no stageFailed findings', () => {
    const { container } = render_([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a stage-failed finding with the SFAIL tag and its failure reason', async () => {
    const user = userEvent.setup();
    const catalog = [{
      type: 'stageFailed', stageId: 3, impactBand: 'critical', variant: 'stageFailure',
      metric: 'stageFailureReason', value: 'ExecutorLostFailure',
      recommendation: 'Inspect the driver log for the failure reason.',
    }] as unknown as Finding[];
    render_(catalog);
    expect(screen.getByRole('heading', { name: 'Failed Stages' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^failed stages$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 3/i })).toBeInTheDocument();
    expect(screen.getByText(/ExecutorLostFailure/)).toBeInTheDocument();
  });

  it('shows the SFAIL tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const catalog = [
      { type: 'stageFailed', stageId: 1, impactBand: 'critical', value: 'ExecutorLostFailure', recommendation: 'r1' },
      { type: 'stageFailed', stageId: 3, impactBand: 'critical', value: 'FetchFailed', recommendation: 'r3' },
    ] as unknown as Finding[];
    const { container } = render_(catalog);
    expect(screen.getByText('SFAIL')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('flags every affected stage, not just the worst', async () => {
    const user = userEvent.setup();
    const catalog = [
      { type: 'stageFailed', stageId: 1, impactBand: 'critical', value: 'ExecutorLostFailure', recommendation: 'r1' },
      { type: 'stageFailed', stageId: 3, impactBand: 'critical', value: 'FetchFailed', recommendation: 'r3' },
    ] as unknown as Finding[];
    render_(catalog);
    await user.click(screen.getByRole('button', { name: /^failed stages$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 3/i })).toBeInTheDocument();
  });

  it('shows a row\'s recommendation by default, with no per-row toggle', async () => {
    const catalog = [{
      type: 'stageFailed', stageId: 3, impactBand: 'critical', value: 'ExecutorLostFailure',
      recommendation: 'Inspect the driver log for the failure reason.',
    }] as unknown as Finding[];
    render_(catalog);
    expect(screen.getByText('Inspect the driver log for the failure reason.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /confidence|evidence|task detail/i })).not.toBeInTheDocument();
  });

  it('defaults the card collapsed, with a lead summary counting failed stages', () => {
    const catalog = [{
      type: 'stageFailed', stageId: 3, impactBand: 'critical', value: 'ExecutorLostFailure', recommendation: 'r',
    }] as unknown as Finding[];
    render_(catalog);
    const cardButton = screen.getByRole('button', { name: 'Failed Stages' });
    expect(cardButton).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('stage failed outright')).toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'stageFailed', stageId: i + 1, impactBand: 'critical', value: 'ExecutorLostFailure', recommendation: `r${i}`,
    })) as unknown as Finding[];
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    render_(catalog, makeAppModel(stageNames));
    await user.click(screen.getByRole('button', { name: 'Failed Stages' }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });

  it('paginates the stage list 6-at-a-time, resetting to page 1 on a fresh appModel', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'stageFailed', stageId: i + 1, impactBand: 'critical', value: 'ExecutorLostFailure', recommendation: `r${i}`,
    })) as unknown as Finding[];
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
