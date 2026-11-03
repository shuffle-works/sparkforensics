import { useMemo, type ReactNode } from 'react';

import type { AppModel, Finding, TaskData } from '@sparkforensics/core/types.ts';
import { emptyAppModel, store, useWidgetDensity } from '@/store/store';
import type { InterpretationState } from '@/view/interpretation';
import { BoardLayoutContext } from '@/view/BoardLayoutContext';
import { buildBoardLayout, type BoardLayout, type FindingRowLayout, type LayoutCard } from '@/view/board-layout';
import { emptySelection, IMPACT_BANDS, type FilterSelection } from '@/view/finding-filter';

/** A selection that lists every band, as a board handed its findings directly does. */
const ALL_BANDS: FilterSelection = { ...emptySelection(), impactBands: new Set(IMPACT_BANDS) };
import { InlineEvidence } from '@/view/InlineEvidence';
import { useInterpretation } from '@/view/interpretation';
import type { TriageTarget } from '@/view/triage-target';
import { WidgetGridItem } from '@/view/WidgetGrid';
import { ImpactBoard } from '@/view/widgets/ImpactBoard';
import { RunVerdict } from '@/view/widgets/RunVerdict';

/** An empty run's layout with extra grid cards listed under `keys`, for a card rendered on its own
 * that should take its disclosure from the board. */
export function layoutWithCards(keys: readonly string[]): BoardLayout {
  const layout = buildBoardLayout({ interpretation: null, appModel: emptyAppModel(), catalog: [], configFindings: [], selection: emptySelection(), density: 'basic' });
  const cards = new Map(layout.cards);
  for (const key of keys) cards.set(key, { key, tab: 'findings', rowKeys: [] } satisfies LayoutCard);
  return { ...layout, cards };
}

export function BoardWithCards({ keys, children }: { keys: readonly string[]; children: ReactNode }) {
  return <BoardLayoutContext.Provider value={layoutWithCards(keys)}>{children}</BoardLayoutContext.Provider>;
}

/** What `FilteredBoard` builds for a test that renders a piece of the board on its own: the layout
 * of the findings under the store's interpretation and density, provided to the piece. */
export function useTestLayout(
  appModel: AppModel,
  catalog: readonly Finding[],
  configFindings: readonly Finding[] = [],
  selection: FilterSelection = ALL_BANDS,
  { withVerdict = true }: { withVerdict?: boolean } = {},
): BoardLayout {
  const interpretation = useInterpretation();
  const density = useWidgetDensity();
  return useMemo(() => {
    // A board shown without the verdict's steps lists every finding as a row.
    const board = interpretation && !withVerdict ? { ...interpretation, data: { ...interpretation.data, verdict: { ...interpretation.data.verdict, steps: [] } } } : interpretation;
    return buildBoardLayout({ interpretation: board, appModel, catalog, configFindings, selection, density });
  }, [interpretation, appModel, catalog, configFindings, selection, density, withVerdict]);
}

export function TestImpactBoard({
  appModel,
  catalog,
  configFindings = [],
  selection,
  onRoute = () => {},
  getTaskData = async () => ({ taskEvents: [] }) as unknown as TaskData,
  withVerdict = false,
}: {
  appModel: AppModel;
  catalog: Finding[];
  configFindings?: Finding[];
  selection?: FilterSelection;
  onRoute?: (target: TriageTarget) => void;
  getTaskData?: (stageId: number) => Promise<TaskData>;
  /** Whether the verdict's steps lead with their findings, which then have no board row. */
  withVerdict?: boolean;
}) {
  const layout = useTestLayout(appModel, catalog, configFindings, selection, { withVerdict });
  return (
    <BoardLayoutContext.Provider value={layout}>
      <ImpactBoard layout={layout} widgetProps={{ appModel, catalog, configFindings, getTaskData }} onRoute={onRoute} />
    </BoardLayoutContext.Provider>
  );
}

export function TestRunVerdict({
  appModel = emptyAppModel(),
  catalog,
  configFindings = [],
  interpretation,
  onRoute = () => {},
  onShowMoreFindings = () => {},
  moreFindingsCount,
  withEvidence = false,
}: {
  appModel?: AppModel;
  catalog: Finding[];
  configFindings?: Finding[];
  interpretation: InterpretationState;
  onRoute?: (target: TriageTarget) => void;
  onShowMoreFindings?: () => void;
  moreFindingsCount?: number;
  /** Whether each step shows its widget's evidence; without it every step routes to its card. */
  withEvidence?: boolean;
}) {
  const layout = useTestLayout(appModel, catalog, configFindings);
  const steps = useMemo(() => (withEvidence ? layout.steps : layout.steps.map((step) => ({ ...step, evidence: null }))), [layout, withEvidence]);
  const widgetProps = { appModel, catalog, configFindings, getTaskData: async () => ({ taskEvents: [] }) as unknown as TaskData, activeFileId: null };
  return (
    <BoardLayoutContext.Provider value={layout}>
      <RunVerdict
        interpretation={interpretation}
        onRoute={onRoute}
        onShowMoreFindings={onShowMoreFindings}
        moreFindingsCount={moreFindingsCount}
        steps={steps}
        renderEvidence={(evidence, finding) => <InlineEvidence widget={evidence.widget} widgetProps={widgetProps} stated={[finding]} panel={evidence.panel} cardKey={evidence.cardKey} />}
      />
    </BoardLayoutContext.Provider>
  );
}

/** The row the layout gives a finding that has no evidence card. */
export function findingRowOf(finding: Finding): FindingRowLayout {
  return { kind: 'finding', lineKey: `row:${finding.id ?? finding.type}`, finding, evidence: { widget: null, panel: null, cardKey: null } };
}

/** Renders `ui` inside a board card that is open, for a widget whose card a test must read the body of:
 * a collapsed card does not mount its body. */
export function renderInOpenCard(ui: ReactNode, render: (ui: ReactNode) => unknown, cardKey = 'open-card') {
  store.getState().setCardOpen(cardKey, true);
  return render(
    <BoardWithCards keys={[cardKey]}>
      <WidgetGridItem cardId={cardKey}>{ui}</WidgetGridItem>
    </BoardWithCards>,
  );
}
