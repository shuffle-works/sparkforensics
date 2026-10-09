// @vitest-environment jsdom
// Type and hit-area floor for the dashboard: text a person reads is at least
// 12px (`text-xs`), and short links and buttons reach a 24px hit area through
// the `tap-target-comfortable` overlay.
import { test, expect, describe } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Table, TableHead, TableHeader, TableRow } from '../../src/components/ui/table';
import { ChartCopyBar } from '../../src/view/charts/ChartTheme';
import { Chip, TagBadge } from '../../src/view/ImpactBadge';
import { PlanExplorer } from '../../src/view/widgets/PlanExplorer';
import { PlanView } from '../../src/view/widgets/PlanView';
import type { AppModel, PlanNode } from '@sparkforensics/core/types.ts';

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

describe('hit-area floor', () => {
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
