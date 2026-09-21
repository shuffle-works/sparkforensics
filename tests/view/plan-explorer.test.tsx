// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanExplorer } from '../../src/view/widgets/PlanExplorer';
import { store } from '../../src/store/store';
import type { AppModel, PlanNode } from '@sparkforensics/core/types.ts';

const node = (name: string, detail: string, children: PlanNode[] = []): PlanNode => ({
  name,
  detail,
  metrics: [],
  children,
});

function makeAppModel(planTree: PlanNode | null, stageId = 1, physicalPlanDescription = ''): AppModel {
  return {
    app: null,
    stages: new Map([[stageId, { id: stageId, sqlExecutionId: 1 }]]),
    executors: { added: [], removed: [] },
    sql: new Map([[1, { id: 1, physicalPlanDescription, planTree }]]),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

describe('PlanExplorer', () => {
  it('renders nothing and does not throw when there is no planTree', () => {
    const { container } = render(<PlanExplorer stageId={1} appModel={makeAppModel(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing and does not throw for a stage with no linked SQL execution at all', () => {
    const appModel = makeAppModel(null);
    appModel.stages.set(2, { id: 2 }); // no sqlExecutionId
    const { container } = render(<PlanExplorer stageId={2} appModel={appModel} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when stageId does not exist in appModel at all', () => {
    const { container } = render(<PlanExplorer stageId={999} appModel={makeAppModel(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('never throws even when the plan tree is malformed', () => {
    const planTree = node('Root', 'Root', [
      node('Scan parquet', 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []'),
      // @ts-expect-error deliberately malformed child to prove render-time resilience
      'not-a-node',
    ]);
    expect(() => render(<PlanExplorer stageId={1} appModel={makeAppModel(planTree)} />)).not.toThrow();
  });

  it('collapses the plan context behind a "Plan context" toggle by default, expanding the tree (default tab) on click', async () => {
    const user = userEvent.setup();
    const planTree = node('Scan parquet', 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []');

    render(<PlanExplorer stageId={1} appModel={makeAppModel(planTree)} />);

    const trigger = screen.getByRole('button', { name: /plan context/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('tab', { name: 'Tree' })).not.toBeInTheDocument();

    await user.click(trigger);

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('tab', { name: 'Tree' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Scan parquet')).toBeVisible();
  });

  it('renders the full plan tree and, on the Summary tab, the condensed category rollup', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [
      node('Scan parquet', 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []'),
      node('SortMergeJoin', 'SortMergeJoin [id#1], [id#2], Inner'),
    ]);

    render(<PlanExplorer stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('button', { name: /plan context/i }));

    expect(screen.getByText('Scan parquet')).toBeInTheDocument();
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: 'Summary' }));

    expect(screen.getByText('Sources (1)')).toBeInTheDocument();
    expect(screen.getByText(/events \(parquet\)/)).toBeInTheDocument();
    expect(screen.getByText('Joins (1)')).toBeInTheDocument();
    expect(screen.getByText(/SortMergeJoin on id \/ id/)).toBeInTheDocument();
  });

  it('attaches a warning badge to the node that caused it (CartesianProduct), collapsed by default', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);

    // Confidence is an Advanced-tier-only signal (RowStatusCluster, gated via
    // AdvancedOnly): the badge itself is unconditional, its confidence text isn't.
    store.getState().setWidgetDensity('advanced');
    try {
      render(<PlanExplorer stageId={1} appModel={makeAppModel(planTree)} />);
      await user.click(screen.getByRole('button', { name: /plan context/i }));

      const summary = screen.getByText('CartesianProduct').closest('summary') as HTMLElement;
      expect(summary.textContent).toContain('CartesianProduct detected');
      expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
    } finally {
      store.getState().setWidgetDensity('basic');
    }
  });
});
