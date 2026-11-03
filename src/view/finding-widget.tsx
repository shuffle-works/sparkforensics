import { memo, useEffect, useRef, useState, type ComponentType, type ReactNode } from 'react';

import { findingName, titleCase, findingsOfType, worstImpactBand } from '@sparkforensics/core/view-model';
import { VISIBLE_LIMIT } from './visible-limit';
import type { AppModel, Finding, FindingOf, FindingType, TaskData } from '@sparkforensics/core/types';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useWidgetDensity } from '@/store/store';
import type { WidgetProps } from '@/view/detector-registry';
import type { PanelInput, RowsOf, WidgetRow } from '@/view/evidence-panel';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { TagBadge } from '@/view/ImpactBadge';
import { useInlineEvidence } from '@/view/InlineEvidenceContext';
import { useInterpretation } from '@/view/interpretation';
import { RowPagination } from '@/view/RowPagination';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import type { TriageTarget } from '@/view/triage-target';
import { usePagedRows } from '@/view/usePagedRows';
import type { SortMode } from '@/view/impact-sort';
import { useSortMode } from '@/view/useSortMode';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';

const NOTHING_STATED: ReadonlySet<string> = new Set();
const NO_TASK_DATA = (): Promise<TaskData> => Promise.reject(new Error('This widget was given no task data source.'));

/** The props of a finding widget: the registry's `WidgetProps`, where a host with no task data source
 * (a test, the docs example) may leave out `getTaskData`. */
export type FindingWidgetProps = Omit<WidgetProps, 'getTaskData'> & Partial<Pick<WidgetProps, 'getTaskData'>>;

export interface RowSections<R> {
  key: (row: R) => string;
  title: (key: string, rows: readonly R[]) => string;
}

/** What a widget decides about its finding type, apart from how a row looks. The registry holds the
 * model, so the panel check and the widget read the same `rows`. */
export interface FindingWidgetModel<T extends FindingType, R extends WidgetRow<T>> {
  type: T;
  /** The rows the widget shows, in base order. Pure: it takes everything it decides from. */
  rows: RowsOf<T, R>;
  /** The card title when the plural reads better than the finding's name. */
  title?: string;
  /** The row's stage number, for the stage sort. */
  stageOf: (row: R) => number | null;
  /** The collapsed card's lead metric and context; the card has no summary when omitted. */
  summary?: (rows: readonly R[]) => { value: ReactNode; context?: string };
  /** Classes of the tag badge, for a family with its own tag colour. */
  tagClassName?: string;
  /** The doc anchor the tag badge links to, from the rows, for a type whose findings each carry their own. */
  tagDocAnchor?: (rows: readonly R[]) => string | undefined;
  /** Mounts the card when there are no rows too: a run-wide reference tile whose `Lead` and `Summary`
   * carry its content. The tag, fix and sort toggle belong to rows, so they appear only with them. */
  alwaysMounted?: boolean;
  /** The findings the widget is for; the type's findings in the catalog when omitted. */
  findings?: (props: Pick<WidgetProps, 'catalog' | 'configFindings'>) => readonly FindingOf<T>[];
  /** The "Jump to stage" option's text for a row; the card has a jump control, shown with the paging,
   * when it is given. */
  jumpLabel?: (row: R) => string;
  /** Splits the rows into headed sections, each with its own paging, in the order they first appear. */
  sections?: RowSections<R>;
  /** The element each row sits in, with the classes its layout needs. */
  rowElement?: 'li' | 'div' | 'tr';
  rowClassName?: string;
  /** Rows are divided by the shared row separator. */
  separated?: boolean;
  /** Classes of the element that holds the rows. */
  listClassName?: string;
}

export interface FindingRowProps<R> {
  row: R;
  appModel: AppModel;
  getTaskData: (id: number) => Promise<TaskData>;
}

/** What a widget's file adds to its model: how one row looks, and what sits above the rows. */
export interface FindingWidgetView<R> {
  Row: ComponentType<FindingRowProps<R>>;
  /** Content above the rows, inside the card: the run's findings, the rows in display order, and the density. */
  Lead?: ComponentType<{ appModel: AppModel; catalog: readonly Finding[]; rows: readonly R[]; density: PanelInput<FindingType>['density'] }>;
  /** The collapsed card's lead metric, for a summary that needs more than the rows (the run's data or
   * a chart model); it takes the place of the model's `summary`. */
  Summary?: ComponentType<{ appModel: AppModel; rows: readonly R[]; density: PanelInput<FindingType>['density'] }>;
  /** Wraps each paged list of rows, for rows that are table rows and need their table and header. */
  Frame?: ComponentType<{ children: ReactNode }>;
  /** What the header shows beside the title while the card is open, from the rows and the density. */
  Status?: ComponentType<{ rows: readonly R[]; density: PanelInput<FindingType>['density'] }>;
}

/** The findings a model's widget is for, from the run's two finding streams. */
export function findingsFor<T extends FindingType>(
  model: Pick<FindingWidgetModel<T, WidgetRow<T>>, 'type' | 'findings'>,
  props: Pick<WidgetProps, 'catalog' | 'configFindings'>,
): readonly FindingOf<T>[] {
  return model.findings ? model.findings(props) : findingsOfType(props.catalog, model.type);
}

/** The title of a finding widget's card: the finding's core name unless the model gives a plural. */
export function cardTitle(type: FindingType, title?: string): string {
  return title ?? titleCase(findingName(type));
}

function AnchoredRow({ row, as: Element, className, children }: { row: AnyRow; as: RowElement; className: string; children: ReactNode }) {
  const anchor = useAnchoredRow([...row.findings] as Finding[]);
  return (
    <Element
      ref={anchor.ref as never}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`${className} transition-colors ${anchor.flashClassName}`}
    >
      {children}
    </Element>
  );
}

type RowElement = 'li' | 'div' | 'tr';

const LIST_ELEMENT = { li: 'ul', div: 'div', tr: 'tbody' } as const;

/** What the paged list needs of a row: the findings it stands for. */
type AnyRow = { readonly findings: readonly Finding[] };

function groupRows<R extends AnyRow>(rows: readonly R[], { key, title }: RowSections<R>): { title: string; rows: R[] }[] {
  const byKey = new Map<string, R[]>();
  for (const row of rows) {
    const group = byKey.get(key(row));
    if (group) group.push(row);
    else byKey.set(key(row), [row]);
  }
  return [...byKey].map(([groupKey, group]) => ({ title: title(groupKey, group), rows: group }));
}

interface RowListProps<R extends AnyRow> {
  rows: readonly R[];
  Row: ComponentType<FindingRowProps<R>>;
  appModel: AppModel;
  getTaskData: (id: number) => Promise<TaskData>;
  routeTarget: TriageTarget | null;
  sortMode: SortMode;
  jumpLabel?: (row: R) => string;
  Frame?: ComponentType<{ children: ReactNode }>;
  rowElement: RowElement;
  rowClassName: string;
  listClassName: string;
}

/** One paged list of rows in display order. A new file or a new sort order starts it on the first page,
 * and a route to one of its findings opens the page that holds it. */
function RowList<R extends AnyRow>({
  rows, Row, appModel, getTaskData, routeTarget, sortMode, jumpLabel, Frame, rowElement, rowClassName, listClassName,
}: RowListProps<R>) {
  const [page, setPage] = useState(0);
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setPage(0);
  }, [appModel, sortMode]);

  const List = LIST_ELEMENT[rowElement];
  const routeIndex = routeTarget ? rows.findIndex((row) => row.findings.includes(routeTarget.finding)) : null;
  const { totalPages, effectivePage, visible } = usePagedRows([...rows], page, setPage, routeIndex);
  const list = (
    <List className={listClassName}>
      {visible.map((row, i) => (
        <AnchoredRow key={row.findings[0].id ?? i} row={row} as={rowElement} className={rowClassName}>
          <Row row={row} appModel={appModel} getTaskData={getTaskData} />
        </AnchoredRow>
      ))}
    </List>
  );
  return (
    <>
      {Frame ? <Frame>{list}</Frame> : list}
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
        renderJumpControl={jumpLabel ? () => (
          <Select
            value={String(effectivePage * VISIBLE_LIMIT)}
            onValueChange={(value) => setPage(Math.floor(Number(value) / VISIBLE_LIMIT))}
          >
            <SelectTrigger size="sm" aria-label="Jump to stage">
              <SelectValue placeholder="Jump to stage" />
            </SelectTrigger>
            <SelectContent>
              {rows.map((row, i) => (
                <SelectItem key={row.findings[0].id ?? i} value={String(i)}>{jumpLabel(row)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : undefined}
      />
    </>
  );
}

/** A finding widget: the card frame, title, tag, sort, paging, route index and row anchors around the
 * rows `model.rows` gives, and nothing when it gives none. */
export function defineFindingWidget<T extends FindingType, R extends WidgetRow<T>>(
  model: FindingWidgetModel<T, R>,
  { Row, Lead, Status, Summary, Frame }: FindingWidgetView<R>,
) {
  const { type, stageOf, summary, jumpLabel, sections, alwaysMounted = false, rowElement = 'div', listClassName = 'space-y-3' } = model;
  const rowClassName = [model.rowClassName, model.separated ? ROW_SEPARATOR_CLASS : undefined].filter(Boolean).join(' ');

  const FindingWidget = memo(function FindingWidget({
    appModel,
    catalog,
    configFindings,
    getTaskData = NO_TASK_DATA,
    defaultCollapsed = true,
  }: FindingWidgetProps) {
    const density = useWidgetDensity();
    const inline = useInlineEvidence();
    const stated = inline?.stated ?? NOTHING_STATED;
    const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
    const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
    const activeRouteTarget = useActiveRouteTarget();

    const localityChart = useInterpretation()?.data.coreLocality?.chart;
    const findings = findingsFor(model, { catalog, configFindings });
    const input: PanelInput<T> = { findings, stated, density, appModel, inPanel: inline !== null, catalog, localityChart };
    const rows = model.rows(input);

    if (rows.length === 0 && !alwaysMounted) return null;

    const groups: { title: string | null; rows: readonly R[] }[] = rows.length === 0 ? [] : sections ? groupRows(rows, sections) : [{ title: null, rows }];
    const ordered = groups.map((group) => ({ ...group, ordered: orderBy([...group.rows], (row) => row.findings, stageOf) }));
    const shown = rows.flatMap((row) => row.findings) as Finding[];
    const band = worstImpactBand(shown);
    const lead = rows.length > 0 ? summary?.(rows) : undefined;
    const lists = ordered.map((group) => (
      <RowList
        key={group.title ?? ''}
        rows={group.ordered}
        Row={Row}
        appModel={appModel}
        getTaskData={getTaskData}
        routeTarget={activeRouteTarget}
        sortMode={sortMode}
        jumpLabel={jumpLabel}
        Frame={Frame}
        rowElement={rowElement}
        rowClassName={rowClassName}
        listClassName={listClassName}
      />
    ));

    return (
      <WidgetCard
        title={cardTitle(type, model.title)}
        fixFor={shown}
        impactBand={band}
        badges={
          <>
            {band ? <TagBadge type={type} impactBand={band} className={model.tagClassName} docAnchor={model.tagDocAnchor?.(rows)} /> : null}
            {groups.some((group) => canToggleSort(group.rows, (row) => row.findings, stageOf, cardOpen)) ? (
              <SortModeToggle mode={sortMode} onChange={setSortMode} />
            ) : null}
          </>
        }
        statusBadge={Status ? <Status rows={rows} density={density} /> : undefined}
        open={cardOpen}
        onOpenChange={setCardOpen}
        summary={Summary
          ? <Summary appModel={appModel} rows={rows} density={density} />
          : lead ? <WidgetLeadSummary value={lead.value} context={lead.context ?? findingCount(shown.length)} /> : undefined}
      >
        {Lead ? <Lead appModel={appModel} catalog={catalog} rows={ordered.flatMap((group) => group.ordered)} density={density} /> : null}
        {rows.length === 0 ? null : sections ? (
          <div className="space-y-4">
            {ordered.map((group, i) => (
              <section key={group.title} className="space-y-2">
                <h4 className="font-heading text-sm font-medium">{group.title}</h4>
                {lists[i]}
              </section>
            ))}
          </div>
        ) : lists}
      </WidgetCard>
    );
  });

  return Object.assign(FindingWidget, { model });
}
