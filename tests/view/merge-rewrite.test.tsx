// tests/view/merge-rewrite.test.tsx
// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { store } from '@/store/store';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { MergeRewrite } from '@/view/widgets/MergeRewrite';
import type { Finding } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';

const estimate = (stageTaskMs: number) => ({ basis: 'serial', wallClock: { low: 100, high: 100 }, estimateMethod: 'measured', stageTaskMs });

function finding(overrides: Record<string, unknown> = {}): Finding {
  return {
    type: 'mergeRewrite',
    executionId: 1,
    stageIds: [5],
    impactBand: 'info',
    rule: 'rewrittenRows',
    metric: 'rewrittenRows',
    value: 800000,
    rewrittenRows: 800000,
    changedRows: 300000,
    filesBefore: 8,
    filesAfter: 8,
    partitionsScanned: 4,
    partitionsTouched: 4,
    target: null,
    recommendation: 'Most rows the MERGE rewrote did not change: filter the MERGE source.',
    impactEstimate: estimate(1000),
    ...overrides,
  } as unknown as Finding;
}

function renderWidget(catalog: Finding[]) {
  installInterpretation(catalog);
  return render(
    <DocsProvider>
      <EvidenceAvailabilityProvider>
        <MergeRewrite catalog={catalog} defaultCollapsed={false} />
      </EvidenceAvailabilityProvider>
    </DocsProvider>,
  );
}

const rows = () => screen.getAllByRole('listitem').map((li) => li.textContent ?? '');

test('renders nothing when no mergeRewrite finding is present', () => {
  const { container } = renderWidget([{ type: 'spill', stageId: 1, impactBand: 'warning' } as unknown as Finding]);
  expect(container.firstChild).toBeNull();
});

test('names a row by its query and target, and shows the counts instead of the advice line', () => {
  renderWidget([finding({ executionId: 4, target: 'sales.orders' })]);
  expect(screen.getByRole('heading', { name: 'MERGE rewrites' })).toBeInTheDocument();
  expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
  const [row] = rows();
  expect(row).toContain('MERGE query 4 on sales.orders');
  expect(row).toContain('800,000 unmodified rows rewritten, 300,000 rows inserted, updated or deleted.');
  expect(row).toContain('Target files: 8 before skipping, 8 after.');
  expect(row).toContain('Partitions: 4 scanned, 4 changed.');
  expect(row).not.toContain('Most rows the MERGE rewrote');
  expect(screen.getByRole('button', { name: 'Open details for Stage 5' })).toBeInTheDocument();
});

test('leaves the target out when the log names none', () => {
  renderWidget([finding({ executionId: 4 })]);
  expect(rows()[0]).toContain('MERGE query 4 800,000');
});

test('combines MERGE commands with identical counts into one row', () => {
  renderWidget([
    finding({ executionId: 4, target: 'sales.orders', stageIds: [5] }),
    finding({ executionId: 7, target: 'sales.orders', stageIds: [9] }),
  ]);
  const items = rows();
  expect(items).toHaveLength(1);
  expect(items[0]).toContain('2 MERGE commands (queries 4 and 7) on sales.orders');
  expect(items[0].match(/800,000 unmodified rows rewritten/g)).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Open details for Stage 5' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open details for Stage 9' })).toBeInTheDocument();
});

test('omits the target from a combined row when the commands write different targets', () => {
  renderWidget([
    finding({ executionId: 4, target: 'a' }),
    finding({ executionId: 7, target: 'b' }),
    finding({ executionId: 9, target: 'a' }),
  ]);
  expect(rows()[0]).toContain('3 MERGE commands (queries 4, 7 and 9) 800,000');
});

test('names a MERGE that trips both rules once', () => {
  renderWidget([
    finding({ executionId: 4, rule: 'rewrittenRows' }),
    finding({ executionId: 4, rule: 'weakSkipping' }),
  ]);
  expect(rows()).toHaveLength(1);
  expect(rows()[0]).toContain('MERGE query 4 ');
});

test('keeps MERGE commands with different counts in separate rows', () => {
  renderWidget([
    finding({ executionId: 4 }),
    finding({ executionId: 7, rewrittenRows: 500000 }),
  ]);
  expect(rows()).toHaveLength(2);
});

test('shows the Impact/Stage sort buttons at advanced density only when the stage order differs', () => {
  store.getState().setWidgetDensity('advanced');
  const two = (first: number[], second: number[]) => [
    finding({ executionId: 4, stageIds: first, impactEstimate: estimate(1000) }),
    finding({ executionId: 7, stageIds: second, rewrittenRows: 500000, impactEstimate: estimate(9000) }),
  ];
  const { unmount } = renderWidget(two([9], [5]));
  expect(screen.getByRole('group', { name: /sort order/i })).toBeInTheDocument();
  unmount();

  renderWidget(two([], []));
  expect(screen.queryByRole('group', { name: /sort order/i })).not.toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});
