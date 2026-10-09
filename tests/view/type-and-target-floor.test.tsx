// @vitest-environment jsdom
// Type and hit-area floor for the dashboard: text a person reads is at least
// 12px (`text-xs`), and short links and buttons reach a 24px hit area through
// the `tap-target-comfortable` overlay.
import { test, expect, describe, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Table, TableHead, TableHeader, TableRow } from '../../src/components/ui/table';
import { ChartCopyBar } from '../../src/view/charts/ChartTheme';
import { Chip, TagBadge } from '../../src/view/ImpactBadge';
import { PlanExplorer } from '../../src/view/widgets/PlanExplorer';
import { PlanView } from '../../src/view/widgets/PlanView';
import { DocsProvider } from '../../src/view/DocsContext';
import { DropZone } from '../../src/view/DropZone';
import { PinnedStageDeltas, PairTable } from '../../src/view/PinnedStageDeltas';
import { PlanGraphNodeDetail } from '../../src/view/plan-graph/PlanGraphNodeDetail';
import type { AppModel, PlanNode } from '@sparkforensics/core/types.ts';

// DropZone renders inside DocsProvider; ingest and recent-files are mocked so
// the landing renders without touching the real pipeline.
vi.mock('@/store/useIngest', () => ({
  useIngest: () => ({
    startLoad: vi.fn(),
    startLoadFolder: vi.fn(),
    startLoadFromUrl: vi.fn(),
    pickRecent: vi.fn(),
    resetToDropZone: vi.fn(),
    getTaskData: vi.fn(),
  }),
}));
vi.mock('@sparkforensics/core/recent-files.ts', () => ({
  isSupported: () => false,
  list: vi.fn(async () => []),
  add: vi.fn(async () => ({})),
  remove: vi.fn(async () => {}),
  getHandle: vi.fn(async () => null),
  ensurePermission: vi.fn(async () => true),
  entryId: (name: string, size: number, lastModified: number) => `${name}::${size}::${lastModified}`,
}));

const scanPlan: PlanNode = {
  name: 'Scan parquet',
  detail: 'FileScan parquet [id#1] Location: InMemoryFileIndex(1 paths)[hdfs://cluster/warehouse/events], PushedFilters: []',
  metrics: [],
  children: [],
};

const planAppModel: AppModel = {
  app: null,
  stages: new Map([[1, { id: 1, sqlExecutionId: 1 }]]),
  executors: { added: [], removed: [] },
  sql: new Map([[1, { id: 1, planTree: scanPlan }]]),
  jobs: new Map(),
  runAggregates: null,
  evidenceAvailability: null,
};

describe('text size floor', () => {
  test('table headers render at 12px', () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Stage</TableHead>
          </TableRow>
        </TableHeader>
      </Table>,
    );
    const head = screen.getByRole('columnheader', { name: 'Stage' });
    expect(head.className).toContain('text-xs');
    expect(head.className).not.toMatch(/text-\[\d+px\]/);
  });

  test('tag badges and chips render at 12px', () => {
    render(
      <>
        <TagBadge type="skew" impactBand="warning" />
        <Chip label="SPILL" impactBand="info" />
      </>,
    );
    for (const label of ['SKEW', 'SPILL']) {
      const badge = screen.getByText(label);
      expect(badge.className).toContain('text-xs');
      expect(badge.className).not.toMatch(/text-\[\d+px\]/);
    }
  });
});

const metrics = {
  duration: 1, memoryBytesSpilled: 0, diskBytesSpilled: 0, jvmGCTime: 0, inputBytes: 0,
  outputBytes: 0, executorRunTime: 1, taskCount: 1, failedTasks: 0,
};

describe('text size floor, compare and plan graph', () => {
  test('compare table column labels render at 12px', () => {
    const stage = { id: 1, name: 'Stage', metrics };
    render(<PairTable base={stage} cand={stage} />);
    for (const label of ['Baseline', 'Candidate', 'Δ']) {
      const head = screen.getByRole('columnheader', { name: label });
      expect(head.className).toContain('text-xs');
      expect(head.className).not.toMatch(/text-\[\d+px\]/);
    }
  });

  test('the plan node detail body renders at 12px', () => {
    render(
      <PlanGraphNodeDetail
        node={{
          id: 'n1', sourceNodeId: 'n1', label: 'Scan', category: 'scan', operatorDetail: '',
          primaryMetric: '', segmentIndex: 0, splitRole: null, durationShare: 0, durationSharePct: null,
          findings: [], metrics: [], detailText: 'FileScan parquet [id#1]',
        }}
        onClose={vi.fn()}
      />,
    );
    const body = screen.getByTestId('plan-node-detail-text');
    expect(body.className).toContain('text-xs');
    expect(body.className).not.toMatch(/text-\[\d+px\]/);
  });
});

describe('hit-area floor', () => {
  test('the landing help disclosure is 32px tall (44px on phones) with a full-row hit region', () => {
    render(
      <DocsProvider>
        <DropZone />
      </DocsProvider>,
    );
    const toggle = screen.getByRole('button', { name: /where do i find my event log/i });
    expect(toggle.className).toContain('min-h-8');
    expect(toggle.className).toContain('max-sm:min-h-11');
    expect(toggle.className).toContain('w-full');
  });

  test('the landing primary buttons grow to 44px on phones', () => {
    render(
      <DocsProvider>
        <DropZone />
      </DocsProvider>,
    );
    for (const name of [/choose file/i, /try a sample run/i]) {
      expect(screen.getByRole('button', { name }).className).toContain('max-sm:h-11');
    }
  });

  test('the disabled Pin pair button says why until both stages are picked', async () => {
    const stage = { id: 1, name: 'Stage 1', metrics };
    render(<PinnedStageDeltas baseStages={[stage]} candStages={[stage]} />);
    const pin = screen.getByRole('button', { name: /pin pair/i });
    expect(pin).toBeDisabled();
    expect(pin).toHaveAccessibleDescription('Pick one stage from each run');
    const user = (await import('@testing-library/user-event')).default.setup();
    await user.selectOptions(screen.getByLabelText(/baseline stage/i), '1');
    await user.selectOptions(screen.getByLabelText(/candidate stage/i), '1');
    expect(pin).toBeEnabled();
    expect(screen.queryByText('Pick one stage from each run')).toBeNull();
  });

  test('the chart Table and Copy actions carry the overlay', () => {
    render(<ChartCopyBar caption="c" columns={['a']} rows={[[1]]} />);
    expect(screen.getByRole('button', { name: /table/i }).className).toContain('tap-target-comfortable');
    expect(screen.getByRole('button', { name: /copy/i }).className).toContain('tap-target-comfortable');
  });

  test('a tag pill that links to docs carries the overlay and is not clipped by the badge', () => {
    render(<TagBadge type="skew" impactBand="warning" />);
    const pill = screen.getByText('SKEW').closest('a');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain('tap-target-comfortable');
    expect(pill!.className).toContain('overflow-visible');
  });

  test('the plan view "Plan context" and "full detail" disclosures carry the overlay', () => {
    render(
      <>
        <PlanExplorer stageId={1} appModel={planAppModel} />
        <PlanView stageId={1} appModel={planAppModel} />
      </>,
    );
    expect(screen.getByRole('button', { name: /plan context/i }).className).toContain('tap-target-comfortable');
    for (const summary of screen.getAllByText('full detail')) {
      expect(summary.className).toContain('tap-target-comfortable');
    }
  });
});
