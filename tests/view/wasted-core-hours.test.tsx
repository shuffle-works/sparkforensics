// @vitest-environment jsdom
import { describe, it, test, expect } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { emptyAppModel, store } from '@/store/store';
import { WastedCoreHours } from '@/view/widgets/WastedCoreHours';
import type { AppModel } from '@sparkforensics/core/types.ts';

// 4 cores × 3.6e6 ms (1 h) = 4 core-h allocated; 1.8e6 ms busy = 0.5 core-h
// used ⇒ 3.5 core-h wasted. Same runtime shapes the parser worker posts.
function buildAppModel(overrides: Partial<AppModel> = {}): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 0, endTime: 3_600_000, resources: { executor: { cores: 4, memory: '4g' }, driver: { memory: '2g', cores: 1 } } },
    executors: { added: [{ executorId: '1', timestamp: 0, totalCores: 4 }], removed: [] },
    runAggregates: {
      busyCoreMs: 1_800_000,
      perStage: { 1: { totalTaskDurationSum: 900_000, taskCount: 4 }, 2: { totalTaskDurationSum: 1_800_000, taskCount: 4 } },
    },
    jobs: new Map(),
    ...overrides,
  } as AppModel;
}

describe('WastedCoreHours', () => {
  it('renders nothing without run aggregates', () => {
    const { container } = render(<WastedCoreHours appModel={buildAppModel({ runAggregates: null })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('defaults collapsed with wasted-hours summary; confidence badge only at Advanced tier, once expanded', () => {
    store.getState().setWidgetDensity('basic');
    render(<WastedCoreHours appModel={buildAppModel()} />);
    expect(screen.getByRole('heading', { name: /wasted core-hours/i })).toBeInTheDocument();
    // Summary shows wasted core hours when collapsed
    expect(screen.getByText(/wasted of 4 core-h allocated/)).toBeInTheDocument();
    // Confidence badge is Advanced-only
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
    cleanup();

    store.getState().setWidgetDensity('advanced');
    render(<WastedCoreHours appModel={buildAppModel()} />);
    // Still collapsed: confidence badge stays out of the summary view
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('heading', { name: /wasted core-hours/i }));
    const confidenceBadge = screen.getByText(/low confidence/i);
    expect(confidenceBadge).toBeInTheDocument();
    expect(confidenceBadge).toHaveAttribute(
      'title',
      'This is a design-spike estimate; verify against wall-clock data before acting on it.',
    );
    store.getState().setWidgetDensity('basic');
  });

  it('expands to show detailed breakdown and top-stage list', () => {
    render(<WastedCoreHours appModel={buildAppModel()} />);
    const heading = screen.getByRole('heading', { name: /wasted core-hours/i });
    // Click to expand the card
    heading.click();
    expect(screen.getAllByText(/4 core-h/).length).toBeGreaterThan(0); // allocated
    expect(screen.getAllByText(/0\.5 core-h/).length).toBeGreaterThan(0); // used
    expect(screen.getByText(/Stage 2/)).toBeInTheDocument();
  });

  test('advanced content is Advanced-only when expanded', () => {
    store.getState().setWidgetDensity('basic');
    render(<WastedCoreHours appModel={buildAppModel()} />);
    // Click to expand
    screen.getByRole('heading', { name: /wasted core-hours/i }).click();
    expect(screen.queryByText(/cores over the run; used = core-time/i)).not.toBeInTheDocument();
    cleanup();

    store.getState().setWidgetDensity('advanced');
    render(<WastedCoreHours appModel={buildAppModel()} />);
    // Click to expand
    screen.getByRole('heading', { name: /wasted core-hours/i }).click();
    expect(screen.getByText(/cores over the run; used = core-time/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });
});
