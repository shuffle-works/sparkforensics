// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { RetryWaste } from '../../src/view/widgets/RetryWaste';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { emptyAppModel, store } from '../../src/store/store';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

function makeAppModel(stageNames: Record<number, string>): AppModel {
  const stages = new Map(Object.entries(stageNames).map(([id, name]) => [Number(id), { id: Number(id), name }]));
  return { ...emptyAppModel(), stages };
}

function render_(catalog: Finding[], appModel: AppModel = makeAppModel({ 4: 'shuffle' })) {
  return render(
    <StageDetailProvider>
      <RetryWaste appModel={appModel} catalog={catalog} />
    </StageDetailProvider>,
  );
}

describe('RetryWaste', () => {
  it('renders nothing when the catalog has no retryWaste findings', () => {
    const { container } = render_([]);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a retry-waste finding with the RETRY tag, formatted duration, and the always-visible recommendation at Basic tier, with no extended explanation yet', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [{
      type: 'retryWaste', stageId: 4, impactBand: 'warning', metric: 'retryWasteMs', value: 45000,
      recommendation: 'Investigate executor loss or fetch failures.',
      extended: '3 task attempts were superseded by a later retry, wasting 45s of executor time.',
    }];
    render_(catalog);
    expect(screen.getByRole('heading', { name: 'Retry Waste' })).toBeInTheDocument();
    expect(screen.getByText('RETRY')).toBeInTheDocument();
    // When collapsed, duration appears in summary; rows are in DOM but hidden
    // getAllByText will match both summary and hidden row, but that's ok - we just need >= 1
    expect(screen.getAllByText(/45\.0s/).length).toBeGreaterThanOrEqual(1);
    // Open the card to see the row's always-visible recommendation.
    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 4/i })).toBeInTheDocument();
    expect(screen.getByText(/investigate executor loss or fetch failures/i)).toBeInTheDocument();
    expect(screen.queryByText(/superseded by a later retry/)).not.toBeInTheDocument();
  });

  it('shows the RETRY tag once, in the header, and keeps a per-row impact dot for every flagged stage', () => {
    const catalog: Finding[] = [
      { type: 'retryWaste', stageId: 1, impactBand: 'warning', metric: 'retryWasteMs', value: 40000 },
      { type: 'retryWaste', stageId: 2, impactBand: 'critical', metric: 'retryWasteMs', value: 10000 },
    ];
    const { container } = render_(catalog, makeAppModel({ 1: 'a', 2: 'b' }));
    expect(screen.getByText('RETRY')).toBeInTheDocument();
    // One dot inside the header TagBadge itself, plus one per flagged stage row.
    expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(3);
  });

  it('adds the non-redundant part of the extended explanation at Advanced tier, alongside the recommendation that was already visible at Basic', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [{
      type: 'retryWaste', stageId: 4, impactBand: 'warning', metric: 'retryWasteMs', value: 45000,
      recommendation: 'Investigate executor loss or fetch failures.',
      extended: '3 task attempts were superseded by a later retry, wasting 45s of executor time.',
    }];
    store.getState().setWidgetDensity('advanced');
    render_(catalog);
    // Open the card to view row content where extended explanation is shown
    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    expect(screen.getByText(/45\.0s/)).toBeInTheDocument();
    expect(screen.getByText(/investigate executor loss or fetch failures/i)).toBeInTheDocument();
    expect(screen.getByText(/3 task attempts were superseded by a later retry\./)).toBeInTheDocument();
    expect(screen.queryByText(/wasting 45s of executor time/)).not.toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('flags every affected stage, not just the worst, and defaults to impact order', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      { type: 'retryWaste', stageId: 1, impactBand: 'warning', metric: 'retryWasteMs', value: 40000, impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' } },
      { type: 'retryWaste', stageId: 2, impactBand: 'warning', metric: 'retryWasteMs', value: 10000, impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' } },
    ];
    render_(catalog, makeAppModel({ 1: 'a', 2: 'b' }));
    // Open the card to see rows ordered by impact estimate
    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    const rows = screen.getAllByRole('button', { name: /open details for stage \d/i });
    expect(rows[0]).toHaveAccessibleName(/stage 2/i);
    expect(rows[1]).toHaveAccessibleName(/stage 1/i);
  });

  it('paginates 6-at-a-time, sorted worst-duration-first when impact bands tie', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'retryWaste', stageId: i + 1, impactBand: 'warning', metric: 'retryWasteMs', value: 1000 * (i + 1),
    }));
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    render_(catalog, makeAppModel(stageNames));
    // Open the card to see pagination controls and row details
    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 7/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open details for stage 1$/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 1$/i })).toBeInTheDocument();
  });

  it('paginates 6-at-a-time, resetting to page 1 on a fresh appModel', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 7 }, (_, i) => ({
      type: 'retryWaste', stageId: i + 1, impactBand: 'warning', metric: 'retryWasteMs', value: 1000 * (i + 1),
    }));
    const stageNames = Object.fromEntries(catalog.map((f) => [f.stageId as number, `stage-${f.stageId}`]));
    const { rerender } = render_(catalog, makeAppModel(stageNames));

    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();

    rerender(
      <StageDetailProvider>
        <RetryWaste appModel={makeAppModel(stageNames)} catalog={catalog} />
      </StageDetailProvider>,
    );
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('renders the impact estimate for a flagged finding', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [{
      type: 'retryWaste', stageId: 4, impactBand: 'warning', metric: 'retryWasteMs', value: 1200,
      impactEstimate: { basis: 'serial', wallClock: { low: 1200, high: 1200 }, estimateMethod: 'measured', rawWaste: { value: 1200, unit: 'ms' } },
    }];
    render_(catalog);
    // Open the card to see row content where impact estimate is displayed
    await user.click(screen.getByRole('button', { name: /^retry waste$/i }));
    expect(screen.getByText('Potential savings:')).toBeInTheDocument();
  });
});
