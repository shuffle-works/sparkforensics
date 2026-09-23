// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PlanView } from '../../src/view/widgets/PlanView';
import { store } from '../../src/store/store';
import type { AppModel, PlanNode } from '@sparkforensics/core/types.ts';

const node = (name: string, detail: string, children: PlanNode[] = []): PlanNode => ({
  name,
  detail,
  metrics: [],
  children,
});

function makeAppModel(
  planTree: PlanNode | null,
  stageId = 1,
  stageIds?: number[],
): AppModel {
  return {
    app: null,
    stages: new Map([[stageId, { id: stageId, sqlExecutionId: 1 }]]),
    executors: { added: [], removed: [] },
    sql: new Map([[1, { id: 1, planTree, stageIds }]]),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

afterEach(() => {
  vi.useRealTimers();
  store.getState().closePlanGraph();
});

describe('PlanView', () => {
  it('renders nothing when there is no planTree', () => {
    const { container } = render(<PlanView stageId={1} appModel={makeAppModel(null)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the physical tree by default, without needing a tab click', () => {
    const planTree = node('Root', 'Root', [
      node('Scan parquet', 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []'),
      node('SortMergeJoin', 'SortMergeJoin [id#1], [id#2], Inner'),
    ]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    expect(screen.getByRole('tab', { name: 'Tree' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Scan parquet')).toBeInTheDocument();
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
  });

  it('renders a split Exchange pair as one merged row with the write half\'s metrics, not two nested Exchange rows', () => {
    // Mirrors resolvePlanTree's real split shape (see event-handlers.ts): the
    // write half carries the real metrics/children, detail=''; the read half
    // wraps write, keeps the original detail, metrics=[]. PlanTreeNode is a
    // legacy view that pre-dates the split and must merge both halves back
    // into one row rather than showing them as two nested "Exchange" entries.
    const write: PlanNode = {
      name: 'Exchange', detail: '',
      metrics: [{ name: 'number of output rows', value: 500 }],
      children: [node('Scan parquet', 'FileScan parquet [id#1]')],
      exchangeRole: 'write',
    };
    const read: PlanNode = {
      name: 'Exchange', detail: 'Exchange hashpartitioning(id#1, 200)',
      metrics: [], children: [write], exchangeRole: 'read',
    };
    const planTree = node('Root', 'Root', [read]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    // One row, not a nested pair: only a single "Exchange" name is rendered.
    expect(screen.getAllByText('Exchange')).toHaveLength(1);
    // The write half's metrics surface on that one row.
    expect(screen.getByText(/number of output rows: 500/)).toBeInTheDocument();
    // The write half's child is one level below the merged row, not two.
    expect(screen.getByText('Scan parquet')).toBeInTheDocument();
  });

  it('shows the pre-AQE plan caveat at advanced density', () => {
    const planTree = node('Scan parquet', 'FileScan parquet [id#1]');
    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    expect(screen.getByText(/showing initial \(pre-aqe\) plan/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('hides the pre-AQE plan caveat at basic density', () => {
    const planTree = node('Scan parquet', 'FileScan parquet [id#1]');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    expect(screen.queryByText(/showing initial \(pre-aqe\) plan/i)).not.toBeInTheDocument();
  });

  it('shows a "full detail" toggle on a scan node, revealing its full structured fields', async () => {
    const user = userEvent.setup();
    const planTree = node('Scan parquet', 'FileScan parquet [order_id#1,amount#2] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/orders], PushedFilters: [IsNotNull(order_id)]');

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    const toggle = screen.getByText('full detail');
    expect(screen.queryByText('Columns')).not.toBeInTheDocument();
    await user.click(toggle);

    expect(screen.getByText('Format')).toBeInTheDocument();
    expect(screen.getByText('parquet')).toBeInTheDocument();
    expect(screen.getByText('Columns')).toBeInTheDocument();
    expect(screen.getByText('order_id, amount')).toBeInTheDocument();
    expect(screen.getByText('Filters')).toBeInTheDocument();
  });

  it('does not show a "full detail" toggle on a node with nothing to add', () => {
    const planTree = node('Sort', 'Sort [id#1 ASC], false');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    expect(screen.queryByText('full detail')).not.toBeInTheDocument();
  });

  it('shows a warning badge and text on the node that caused it', () => {
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);
    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    const summary = screen.getByText('CartesianProduct').closest('summary') as HTMLElement;
    expect(summary.textContent).toContain('PLAN');
    expect(summary.textContent).toContain('CartesianProduct detected');
    expect(within(summary).getByText(/low confidence/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('hides the confidence caveat at basic density', () => {
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    const summary = screen.getByText('CartesianProduct').closest('summary') as HTMLElement;
    expect(within(summary).queryByText(/low confidence/i)).not.toBeInTheDocument();
  });

  it('shows the Tree tab plan-validation caveat once for the tab (not per node) at advanced density', () => {
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);
    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    // Must be plain visible text, not RowStatusCluster's hover-only sr-only
    // span: getByText alone can't tell the two apart, since screen.getByText
    // has no visibility filter and matches sr-only content just as happily.
    const caveat = screen.getByText(/derived from best-effort plan-text parsing/i);
    expect(caveat).not.toHaveClass('sr-only');
    expect(caveat.tagName).toBe('P');
    // Rendered at the tab level, so it must not tell the user (already on
    // the Tree tab) to go check the Tree tab.
    expect(caveat.textContent).not.toMatch(/tree tab/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the Tree tab plan-validation caveat at basic density', () => {
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    expect(screen.queryByText(/derived from best-effort plan-text parsing/i)).not.toBeInTheDocument();
  });

  it('shows the Tree tab plan-validation caveat even when the warning node is collapsed below the auto-open depth', () => {
    // CartesianProduct sits at depth 3 (Root=0, A=1, B=2, CartesianProduct=3),
    // below PlanTreeNode's depth<=1 auto-open cutoff, so both its own
    // <details> and its parent B's are collapsed on mount.
    const planTree = node('Root', 'Root', [
      node('A', 'A', [node('B', 'B', [node('CartesianProduct', 'CartesianProduct')])]),
    ]);
    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    const warningDetails = screen.getByText('CartesianProduct').closest('details') as HTMLDetailsElement;
    expect(warningDetails).toHaveProperty('open', false);

    // The caveat lives outside every node's <details>/<summary> (rendered
    // once for the tab): assert that structurally, not just that it's in the
    // document, since getByText alone can't tell "visible" from "hidden by
    // a closed <details>" in jsdom.
    const caveat = screen.getByText(/derived from best-effort plan-text parsing/i);
    expect(caveat.closest('details')).toBeNull();
    store.getState().setWidgetDensity('basic');
  });

  it('shows the Tree tab plan-validation caveat only once even with multiple warning nodes', () => {
    const planTree = node('Root', 'Root', [
      node('CartesianProduct', 'CartesianProduct'),
      node('SomeOtherCartesianProduct', 'CartesianProduct'),
      node('YetAnotherCartesianProduct', 'CartesianProduct'),
    ]);
    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    expect(screen.getAllByText(/derived from best-effort plan-text parsing/i)).toHaveLength(1);
    store.getState().setWidgetDensity('basic');
  });

  it('switches to the Summary tab on click and shows the condensed rollup', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [
      node('Scan parquet', 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []'),
      node('HashAggregate', 'HashAggregate(keys=[region#1], functions=[sum(amount#2)])'),
    ]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));

    expect(screen.getByText('Sources (1)')).toBeInTheDocument();
    expect(screen.getByText(/events \(parquet\)/)).toBeInTheDocument();
    expect(screen.getByText('Aggregations (1)')).toBeInTheDocument();
    expect(screen.getByText(/sum\(amount\) by region/)).toBeInTheDocument();
  });

  it('groups exchanges by partitioning kind with a count, and flags 4 or more with an advisory', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2), exchangeNode(3), exchangeNode(4)]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));

    expect(screen.getByText('Exchanges (4)')).toBeInTheDocument();
    expect(screen.getByText(/hash×4/)).toBeInTheDocument();
    expect(screen.getByText(/consider whether some joins\/aggregations/)).toBeInTheDocument();
  });

  it('does not show the exchanges advisory when there are fewer than 4', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2)]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));

    expect(screen.queryByText(/consider whether some joins\/aggregations/)).not.toBeInTheDocument();
  });

  it('hides the exchanges advisory confidence caveat at basic density', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2), exchangeNode(3), exchangeNode(4)]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
  });

  it('shows the exchanges advisory confidence caveat at advanced density', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2), exchangeNode(3), exchangeNode(4)]);

    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('shows the exchanges advisory plan-validation caveat as plain visible text at advanced density', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2), exchangeNode(3), exchangeNode(4)]);

    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    // Must be plain visible text, not RowStatusCluster's hover-only sr-only
    // span: getByText alone can't tell the two apart.
    const caveat = screen.getByText(/derived from best-effort plan-text parsing/i);
    expect(caveat).not.toHaveClass('sr-only');
    expect(caveat.tagName).toBe('P');
    // Summary-tab wording points at the Tree tab, not itself.
    expect(caveat.textContent).toMatch(/tree tab/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the exchanges advisory plan-validation caveat at basic density', async () => {
    const user = userEvent.setup();
    const exchangeNode = (n: number): PlanNode => {
      const write: PlanNode = { ...node('Exchange', ''), exchangeRole: 'write' };
      return { ...node('Exchange', `hashpartitioning(id#${n}, 4)`, [write]), exchangeRole: 'read' };
    };
    const planTree = node('Root', 'Root', [exchangeNode(1), exchangeNode(2), exchangeNode(3), exchangeNode(4)]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.queryByText(/derived from best-effort plan-text parsing/i)).not.toBeInTheDocument();
  });

  it('hides the Summary tab warnings-row confidence caveat at basic density', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByText(/Warnings \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
  });

  it('shows the Summary tab warnings-row confidence caveat at advanced density', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);

    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.getByText(/low confidence/i)).toBeInTheDocument();
    store.getState().setWidgetDensity('basic');
  });

  it('shows the Summary tab warnings-row plan-validation caveat as plain visible text at advanced density', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);

    store.getState().setWidgetDensity('advanced');
    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    // Must be plain visible text, not RowStatusCluster's hover-only sr-only
    // span: getByText alone can't tell the two apart.
    const caveat = screen.getByText(/derived from best-effort plan-text parsing/i);
    expect(caveat).not.toHaveClass('sr-only');
    expect(caveat.tagName).toBe('P');
    // Summary-tab wording points at the Tree tab, not itself.
    expect(caveat.textContent).toMatch(/tree tab/i);
    store.getState().setWidgetDensity('basic');
  });

  it('hides the Summary tab warnings-row plan-validation caveat at basic density', async () => {
    const user = userEvent.setup();
    const planTree = node('Root', 'Root', [node('CartesianProduct', 'CartesianProduct')]);

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);
    await user.click(screen.getByRole('tab', { name: 'Summary' }));
    expect(screen.queryByText(/derived from best-effort plan-text parsing/i)).not.toBeInTheDocument();
  });

  it('does not throw for a tree containing only a malformed node (no name/detail/children)', () => {
    const planTree = node('Root', 'Root', [{} as PlanNode]);
    expect(() => render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />)).not.toThrow();
  });

  it('still renders real plan content when one sibling node is malformed (missing name)', () => {
    // A malformed sibling node (only the root's nodeName is validated upstream)
    // must degrade gracefully, not blank out an otherwise-parseable plan tree.
    const planTree = node('Root', 'Root', [
      node(
        'Scan parquet',
        'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []',
      ),
      node('SortMergeJoin', 'SortMergeJoin [id#1], [id#2], Inner'),
      {} as PlanNode,
    ]);

    expect(() => render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />)).not.toThrow();

    expect(screen.getByRole('tab', { name: 'Tree' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Scan parquet')).toBeInTheDocument();
    expect(screen.getByText('SortMergeJoin')).toBeInTheDocument();
    expect(screen.queryByText(/couldn.t be parsed/i)).not.toBeInTheDocument();
  });

  it('shows a "View plan graph" button and opens the plan graph route on click', async () => {
    const user = userEvent.setup();
    const planTree = node('SortMergeJoin', 'SortMergeJoin [id#1], [id#2], Inner');

    render(<PlanView stageId={1} appModel={makeAppModel(planTree)} />);

    const button = screen.getByRole('button', { name: 'View plan graph' });
    expect(button).toBeInTheDocument();
    await user.click(button);

    expect(store.getState().planGraph).toEqual({ active: true, stageId: 1, initialScope: 'segment' });
  });
});
