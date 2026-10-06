// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { emptyAppModel, store } from '@/store/store';
import { EfficiencyModel } from '@/view/widgets/EfficiencyModel';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';

// The widget renders the store's interpretation of the run, as the dashboard installs it.
function renderEfficiencyModel(appModel: AppModel) {
  installInterpretation([], appModel);
  return render(<EfficiencyModel />);
}

// Runtime stage shape carries id/parentIds/submittedAt/completedAt, not the
// Stage type's declared stageId; one cast bridges the gap.
function buildStages(completedAt: number): AppModel['stages'] {
  const raw = new Map<number, unknown>([
    [1, { id: 1, parentIds: [], submittedAt: 0, completedAt }],
  ]);
  return raw as unknown as AppModel['stages'];
}

function buildAppModel(overrides: Partial<AppModel> = {}): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 3600000, resources: { executor: { cores: 1, memory: '4g' }, driver: { memory: '2g', cores: 1 } } },
    stages: buildStages(1800000),
    executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, host: 'host-1', totalCores: 2, resourceProfileId: null }], removed: [] },
    runAggregates: { busyCoreMs: 900000, perStage: { 1: { totalTaskDurationSum: 900000, taskCount: 4 } } },
    jobs: new Map(),
    ...overrides,
  };
}

describe('EfficiencyModel', () => {
  it('renders nothing without run aggregates', () => {
    const { container } = renderEfficiencyModel(buildAppModel({ runAggregates: null }));
    expect(container).toBeEmptyDOMElement();
  });

  it('defaults collapsed with wastage-percent summary; all metrics always visible, confidence badge only at Advanced tier, once expanded', () => {
    store.getState().setWidgetDensity('basic');
    renderEfficiencyModel(buildAppModel());

    expect(screen.getByRole('heading', { name: /compute efficiency/i })).toBeInTheDocument();
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();

    // All four metrics visible unconditionally (not gated by AdvancedOnly)
    expect(screen.getByText(/available:/i)).toBeInTheDocument();
    expect(screen.getByText(/driver-bound waste:/i)).toBeInTheDocument();
    expect(screen.getByText(/executor-bound waste:/i)).toBeInTheDocument();
    expect(screen.getByText(/floor \(same executors, zero skew\):/i)).toBeInTheDocument();

    // Summary shows wastage percentage as lead metric (collapsed state summary)
    expect(screen.getByText(/% wasted/)).toBeInTheDocument();
    cleanup();

    store.getState().setWidgetDensity('advanced');
    renderEfficiencyModel(buildAppModel());
    // Still collapsed: confidence badge stays out of the summary view
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('heading', { name: /compute efficiency/i }));
    const confidenceBadge = screen.getByText(/low confidence/i);
    expect(confidenceBadge).toBeInTheDocument();
    expect(confidenceBadge).toHaveAttribute(
      'title',
      'This estimate is derived from a simplified compute model; compare it against wall-clock data before acting on it.',
    );
    store.getState().setWidgetDensity('basic');
  });

  it('recommends driver right-sizing when driver-bound waste dominates', () => {
    // Short active stage => large driver idle => driver waste dominates.
    const appModel = buildAppModel({ stages: buildStages(100000) });
    renderEfficiencyModel(appModel);
    expect(screen.getByText(/spark\.driver/)).toBeInTheDocument();
  });

  it('shows used core-hours and the top stages by task core-time', () => {
    // 2 cores × 1 h = 2 core-h allocated; 900,000 ms busy = 0.25 core-h used, all in stage 1.
    renderEfficiencyModel(buildAppModel());
    expect(screen.getByText(/used:/i)).toBeInTheDocument();
    expect(screen.getAllByText(/0\.25 core-h/).length).toBeGreaterThan(0);
    expect(screen.getByText('Stage 1')).toBeInTheDocument();
  });

  it('names the core count only in Advanced view', () => {
    store.getState().setWidgetDensity('basic');
    renderEfficiencyModel(buildAppModel());
    expect(screen.queryByText(/cores over the run \(cores × the time each executor was alive\); used = core-time/i)).not.toBeInTheDocument();
    cleanup();

    store.getState().setWidgetDensity('advanced');
    renderEfficiencyModel(buildAppModel());
    expect(screen.getByText(/2 cores over the run \(cores × the time each executor was alive\); used = core-time/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('never renders the unverified ~21% marketing figure', () => {
    renderEfficiencyModel(buildAppModel());
    expect(screen.queryByText(/21%/)).not.toBeInTheDocument();
  });

  it('right-sizing paragraph shows when driver or executor waste dominates', () => {
    renderEfficiencyModel(buildAppModel());
    expect(screen.getByText(/most of it is driver waste/i)).toBeInTheDocument();
  });
});
