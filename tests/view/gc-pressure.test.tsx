// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const openStage = vi.fn();
vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage, close: vi.fn() }),
}));

import { GcPressure } from '../../src/view/widgets/GcPressure';
import { emptyAppModel, store } from '../../src/store/store';
import { expectImpactThenStageOrderByAccessibleName } from './_shared/sort-order-toggle';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';

// Fixture matches runtime stage shape (id, not the Stage type's stageId), cast to AppModel['stages'].
function buildAppModel(stages: Record<number, Record<string, unknown>> = {}): AppModel {
  const map = new Map<number, unknown>(
    Object.entries(stages).map(([id, fields]) => [Number(id), { id: Number(id), ...fields }]),
  );
  return { ...emptyAppModel(), stages: map as unknown as AppModel['stages'] };
}

describe('GcPressure', () => {
  it('renders the WidgetCard heading and a GC tag badge for high-GC findings', () => {
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 35, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);

    expect(screen.getByRole('heading', { name: 'GC Pressure' })).toBeInTheDocument();
    expect(screen.getByText('GC')).toBeInTheDocument();
  });

  it('flags every affected stage in the high-GC branch, not just the worst', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      { type: 'gc', stageId: 3, impactBand: 'critical', value: 45, recommendation: 'r' },
      { type: 'gc', stageId: 9, impactBand: 'warning', value: 12, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);
    await user.click(screen.getByRole('button', { name: /^gc pressure$/i }));

    expect(screen.getByRole('button', { name: /open details for stage 3/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 9/i })).toBeInTheDocument();
  });

  it('renders the low-GC (cost) branch and flags every low-GC stage with its recommendation always visible', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = [
      {
        type: 'gc', stageId: 4, direction: 'low', impactBand: 'info', value: 2,
        recommendation: 'GC time unusually low: executor memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.',
      },
      {
        type: 'gc', stageId: 7, direction: 'low', impactBand: 'info', value: 1,
        recommendation: 'GC time unusually low: executor memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.',
      },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);
    await user.click(screen.getByRole('button', { name: /^gc pressure$/i }));

    expect(screen.getByRole('button', { name: /open details for stage 4/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 7/i })).toBeInTheDocument();


    expect(screen.getAllByText(/over-provisioned/i)).toHaveLength(2);
  });

  it('renders both the high-GC and low-GC branches together when both fired', () => {
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'Reduce object creation.' },
      { type: 'gc', stageId: 2, direction: 'low', impactBand: 'info', value: 1, recommendation: 'over-provisioned' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);

    expect(screen.getByText(/GC overhead/i)).toBeInTheDocument();
    expect(screen.getByText(/Low GC/i)).toBeInTheDocument();
  });

  it('renders nothing when there are no gc findings in the catalog', () => {
    const catalog: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'critical' }];
    const { container } = render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('hides the GC% formula caveat note at Basic density', () => {
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);
    expect(screen.queryByText(/total JVM GC time/i)).not.toBeInTheDocument();
  });

  it('shows the GC% formula caveat note at Advanced density', () => {
    store.getState().setWidgetDensity('advanced');
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);
    expect(screen.getByText(/total JVM GC time/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('renders no domain-specific copy', () => {
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'Reduce object creation.' },
    ];
    const { container } = render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);
    expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
  });

  it('shows each flagged stage\'s executor run time alongside its GC%', () => {
    const appModel = buildAppModel({
      1: { executorRunTime: 12345 },
      2: { executorRunTime: 987654 },
    });
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'r' },
      { type: 'gc', stageId: 2, direction: 'low', impactBand: 'info', value: 1, recommendation: 'over-provisioned' },
    ];
    render(<GcPressure catalog={catalog} appModel={appModel} />);

    // Trailing colon + case avoids matching the GC_NOTE explainer's own "executor run time".
    const runTimeLines = screen.getAllByText(/Executor run time:/);
    expect(runTimeLines).toHaveLength(2);
    expect(runTimeLines[0].parentElement?.textContent).toMatch(/12\.3s/);
    expect(runTimeLines[1].parentElement?.textContent).toMatch(/16m/);
  });

  it('shows each flagged stage\'s name next to its stage number', () => {
    const appModel = buildAppModel({
      1: { name: 'count at ShuffleExchange.scala:42' },
    });
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={appModel} />);

    expect(screen.getByText('count at ShuffleExchange.scala:42')).toBeInTheDocument();
  });

  it('keeps every flagged stage reachable through pagination instead of hiding overflow behind a chip', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'gc' as const,
      stageId: i + 1,
      impactBand: 'warning' as const,
      value: 20 + i,
      recommendation: 'r',
    }));
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    // VISIBLE_LIMIT is 6: page 1 shows stages 8-3, stages 1-2 fall to page 2, never hidden behind a "+N" chip.
    expect(screen.getByRole('button', { name: /open details for stage 8/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open details for stage 1$/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/^\+2$/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^next$/i }));

    expect(screen.getByRole('button', { name: /open details for stage 1$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open details for stage 2$/i })).toBeInTheDocument();
  });

  it('renders the impact estimate under the per-stage GC row', () => {
    const finding: Finding = {
      type: 'gc', stageId: 0, impactBand: 'warning', recommendation: 'Reduce GC pressure', value: 4,
      impactEstimate: { basis: 'contended', wallClock: { low: 92, high: 2209.5 }, estimateMethod: 'measured', rawWaste: { value: 1080, unit: 'coreMs' } },
    };
    render(<GcPressure catalog={[finding]} appModel={buildAppModel()} />);
    expect(screen.getByText('92ms-2.2s')).toBeInTheDocument();
  });

  it('defaults to impact order (highest potential savings first), and a toggle flips it back to stage order at advanced density', async () => {
    const user = userEvent.setup();
    store.getState().setWidgetDensity('advanced');
    const catalog: Finding[] = [
      {
        type: 'gc', stageId: 1, impactBand: 'warning', value: 40, recommendation: 'r',
        impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
      },
      {
        type: 'gc', stageId: 2, impactBand: 'warning', value: 20, recommendation: 'r',
        impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
      },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    const stagePills = () => screen.getAllByRole('button', { name: /open details for stage \d/i });
    // Stage 2 has lower GC% (20 vs 40) but higher savings (5000 vs 100ms), so impact order puts it first.
    await expectImpactThenStageOrderByAccessibleName(user, stagePills, /stage 1/i, /stage 2/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the sort toggle at basic density even with a wall-clock estimate, and stays in impact order', () => {
    const catalog: Finding[] = [
      {
        type: 'gc', stageId: 1, impactBand: 'warning', value: 40, recommendation: 'r',
        impactEstimate: { basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured' },
      },
      {
        type: 'gc', stageId: 2, impactBand: 'warning', value: 20, recommendation: 'r',
        impactEstimate: { basis: 'serial', wallClock: { low: 5000, high: 5000 }, estimateMethod: 'measured' },
      },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
    const stagePills = screen.getAllByRole('button', { name: /open details for stage \d/i });
    expect(stagePills[0]).toHaveAccessibleName(/stage 2/i);
    expect(stagePills[1]).toHaveAccessibleName(/stage 1/i);
  });

  it('shows every stage\'s recommendation unconditionally, with no per-row toggle', () => {
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'critical', value: 45, recommendation: 'Reduce object creation for stage 1.' },
      { type: 'gc', stageId: 2, impactBand: 'warning', value: 30, recommendation: 'Reduce object creation for stage 2.' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    // Recommendations render unconditionally now; there's no toggle to collapse them.
    expect(screen.getByText('Reduce object creation for stage 1.')).toBeInTheDocument();
    expect(screen.getByText('Reduce object creation for stage 2.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recommendation/i })).not.toBeInTheDocument();
  });

  it('hides the sort toggle when no finding carries a wall-clock estimate, even at advanced density', async () => {
    store.getState().setWidgetDensity('advanced');
    const catalog: Finding[] = [
      { type: 'gc', stageId: 1, impactBand: 'warning', value: 40, recommendation: 'r' },
      { type: 'gc', stageId: 2, impactBand: 'warning', value: 20, recommendation: 'r' },
    ];
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} />);

    expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('resets pagination back to page 1 when a new file is loaded (appModel identity changes)', async () => {
    const user = userEvent.setup();
    const catalog: Finding[] = Array.from({ length: 8 }, (_, i) => ({
      type: 'gc' as const,
      stageId: i + 1,
      impactBand: 'warning' as const,
      value: 20 + i,
      recommendation: 'r',
    }));
    const { rerender } = render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);
    await user.click(screen.getByRole('button', { name: /^next$/i }));
    expect(screen.getByRole('button', { name: /open details for stage 1$/i })).toBeInTheDocument();

    // A fresh appModel object must reset the page-2 cursor, else the section renders an empty out-of-range slice.
    rerender(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    expect(screen.getByRole('button', { name: /open details for stage 8$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open details for stage 1$/i })).not.toBeInTheDocument();
  });

  it('shows a confidence caveat when the gc finding carries one', () => {
    const catalog: Finding[] = [
      {
        type: 'gc', stageId: 1, impactBand: 'warning', value: 35, recommendation: 'r',
        confidence: 'low',
        validationRequired: 'This finding is gated by a 10-second minimum-runtime floor, our own noise floor for this metric.',
      },
    ];
    store.getState().setWidgetDensity('advanced');
    render(<GcPressure catalog={catalog} appModel={buildAppModel()} defaultCollapsed={false} />);

    const caveat = screen.getByText(/low confidence/i);
    expect(caveat).toBeInTheDocument();
    expect(caveat.getAttribute('title')).toBe(catalog[0].validationRequired);
    store.getState().setWidgetDensity('basic');
  });
});
