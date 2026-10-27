// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ComponentType } from 'react';
import type { Finding } from '@sparkforensics/core/types.ts';

vi.mock('@/view/StageDetailContext', () => ({
  useStageDetail: () => ({ stageId: null, openStage: vi.fn(), close: vi.fn() }),
}));

import { emptyAppModel } from '@/store/store';
import { DocsProvider } from '@/view/DocsContext';
import { EvidenceAvailabilityProvider } from '@/view/EvidenceAvailabilityContext';
import { InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import { ConfigAudit } from '@/view/widgets/ConfigAudit';
import { DuplicatePlanSubtree } from '@/view/widgets/DuplicatePlanSubtree';
import { NestedLoopJoin } from '@/view/widgets/NestedLoopJoin';
import { OverBroadcast } from '@/view/widgets/OverBroadcast';
import { PythonUdf } from '@/view/widgets/PythonUdf';
import { SmallFiles } from '@/view/widgets/SmallFiles';
import { UnderBroadcast } from '@/view/widgets/UnderBroadcast';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

type CatalogWidget = ComponentType<{ catalog: Finding[]; defaultCollapsed?: boolean }>;

function renderIn(ui: React.ReactNode, stated: string[] | null) {
  const body = (
    <DocsProvider>
      <EvidenceAvailabilityProvider>{ui}</EvidenceAvailabilityProvider>
    </DocsProvider>
  );
  return render(
    stated === null
      ? body
      : <InlineEvidenceContext.Provider value={{ stated: new Set(stated) }}>{body}</InlineEvidenceContext.Provider>,
  );
}

const SQL_WIDGETS: Array<{ name: string; Widget: CatalogWidget; type: string; extra?: Record<string, unknown> }> = [
  { name: 'PythonUdf', Widget: PythonUdf, type: 'pythonUdf' },
  { name: 'NestedLoopJoin', Widget: NestedLoopJoin, type: 'nestedLoopJoin' },
  { name: 'SmallFiles', Widget: SmallFiles, type: 'smallFiles' },
  { name: 'UnderBroadcast', Widget: UnderBroadcast, type: 'underBroadcast' },
  { name: 'OverBroadcast', Widget: OverBroadcast, type: 'overBroadcast' },
  {
    name: 'DuplicatePlanSubtree',
    Widget: DuplicatePlanSubtree,
    type: 'duplicatePlanSubtree',
    extra: { rootName: 'SortMergeJoin', subtreeSize: 3, value: 2, sampleRelation: null, occurrencesIdentical: true },
  },
];

describe.each(SQL_WIDGETS)('$name in an evidence panel', ({ Widget, type, extra }) => {
  const make = (id: string, stageId: number): Finding =>
    testFinding({
      type: type as 'pythonUdf', id, stageIds: [stageId], impactBand: 'warning',
      recommendation: `Measured ${id} sentence: fix it.`, ...extra,
    } as never) as Finding;
  const row = (id: string) => (extra ? new RegExp(`${extra.rootName}`) : new RegExp(`Measured ${id} sentence`));

  it('drops the stage pills and the sentence of the stated finding only', () => {
    const [a, b] = [make('a', 11), make('b', 22)];
    installInterpretation([a, b]);
    renderIn(<Widget catalog={[a, b]} defaultCollapsed={false} />, ['a']);
    expect(screen.queryByRole('button', { name: 'Open details for Stage 11' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open details for Stage 22' })).toBeInTheDocument();
    if (!extra) {
      expect(screen.queryByText(row('a'))).not.toBeInTheDocument();
      expect(screen.getByText(row('b'))).toBeInTheDocument();
    } else {
      expect(screen.getAllByText(row('a'))).toHaveLength(1);
    }
  });

  it('keeps every row when the line above states none of them', () => {
    const [a, b] = [make('a', 11), make('b', 22)];
    installInterpretation([a, b]);
    renderIn(<Widget catalog={[a, b]} defaultCollapsed={false} />, []);
    expect(screen.getByRole('button', { name: 'Open details for Stage 11' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open details for Stage 22' })).toBeInTheDocument();
  });

  it('is unchanged outside a panel, even for a finding that would be stated', () => {
    const a = make('a', 11);
    installInterpretation([a]);
    renderIn(<Widget catalog={[a]} defaultCollapsed={false} />, null);
    expect(screen.getByRole('button', { name: 'Open details for Stage 11' })).toBeInTheDocument();
  });
});

describe('ConfigAudit in an evidence panel', () => {
  const make = (id: string, property: string): Finding =>
    testFinding({
      type: 'configAudit', id, property, valueText: `value-${id}`, impactBand: 'info',
      docAnchor: '#config-serializer', recommendation: `Measured ${id} sentence: fix it.`,
    }) as Finding;

  function renderAudit(findings: Finding[], stated: string[] | null) {
    installInterpretation([], emptyAppModel(), findings);
    return renderIn(
      <ConfigAudit appModel={emptyAppModel()} catalog={[]} configFindings={findings} defaultCollapsed={false} getTaskData={async () => ({ metrics: [], fieldNames: [] })} />,
      stated,
    );
  }

  it('drops the sentence of the stated finding but keeps its audited setting and docs link', () => {
    renderAudit([make('a', 'spark.a'), make('b', 'spark.b')], ['a']);
    expect(screen.getByText('spark.a')).toBeInTheDocument();
    expect(screen.getByText('value-a')).toBeInTheDocument();
    expect(screen.queryByText(/Measured a sentence/)).not.toBeInTheDocument();
    expect(screen.getByText('Why spark.a matters')).toBeInTheDocument();
    expect(screen.getByText('spark.b')).toBeInTheDocument();
    expect(screen.getByText('value-b')).toBeInTheDocument();
    expect(screen.getByText(/Measured b sentence/)).toBeInTheDocument();
  });

  it('keeps the audited setting of a stated finding with no docs link', () => {
    const bare = { ...make('a', 'spark.a'), docAnchor: undefined } as Finding;
    renderAudit([bare], ['a']);
    expect(screen.getByText('spark.a')).toBeInTheDocument();
    expect(screen.getByText('value-a')).toBeInTheDocument();
    expect(screen.queryByText(/Why spark.a matters/)).not.toBeInTheDocument();
  });

  it('is unchanged outside a panel', () => {
    renderAudit([make('a', 'spark.a')], null);
    expect(screen.getByText('spark.a')).toBeInTheDocument();
    expect(screen.getByText('value-a')).toBeInTheDocument();
    expect(screen.getByText(/Measured a sentence/)).toBeInTheDocument();
  });
});
