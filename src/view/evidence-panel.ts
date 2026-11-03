import type { LocalityChart } from '@sparkforensics/core/analysis';
import type { AppModel, Finding, FindingOf, FindingType } from '@sparkforensics/core/types';

/** What decides the rows a widget shows. */
export interface PanelInput<T extends FindingType> {
  /** The findings the widget is for. */
  findings: readonly FindingOf<T>[];
  /** Ids of the findings the line above the widget states. Empty outside an evidence panel. */
  stated: ReadonlySet<string>;
  density: 'basic' | 'advanced';
  appModel: AppModel;
  /** Whether the rows render in an evidence panel; true for every panel check. */
  inPanel?: boolean;
  /** The run's findings, for a row that points at another type's finding on its stage. Absent where
   * only whether there are rows is asked, so it never decides whether a row exists. */
  catalog?: readonly Finding[];
  /** The run's core usage by locality, for a row that embeds the chart. */
  localityChart?: LocalityChart;
}

/** One row a widget shows: the findings it stands for, which anchor it and route to it. */
export interface WidgetRow<T extends FindingType = FindingType> {
  readonly findings: readonly FindingOf<T>[];
}

/** The rows of a widget, decided before anything renders. The widget renders exactly these rows, so
 * the rows are the one decision: no rows means no card, no evidence control and no panel. */
export type RowsOf<T extends FindingType, R extends WidgetRow<T>> = (input: PanelInput<T>) => readonly R[];

declare const panelBrand: unique symbol;

/** A panel with at least one row to show. Only `evidencePanel` makes one, so the evidence control,
 * the panel and its route target cannot exist for a widget that has nothing to show. */
export interface EvidencePanel<T extends FindingType> {
  readonly [panelBrand]: true;
  readonly type: T;
  /** The findings the panel's rows stand for. */
  readonly rows: readonly FindingOf<T>[];
}

/** `EvidencePanel` of any one finding type. A plain `EvidencePanel<FindingType>` is invariant. */
export type AnyEvidencePanel = { [T in FindingType]: EvidencePanel<T> }[FindingType];

/** The one constructor: the panel for the rows `rowsOf` gives, or null when it gives none. */
export function evidencePanel<T extends FindingType>(
  type: T,
  rowsOf: RowsOf<T, WidgetRow<T>>,
  input: PanelInput<T>,
): EvidencePanel<T> | null {
  const rows = rowsOf(input);
  if (rows.length === 0) return null;
  return { type, rows: [...new Set(rows.flatMap((row) => row.findings))] } as unknown as EvidencePanel<T>;
}

export function isStated(finding: Finding, stated: ReadonlySet<string>): boolean {
  return finding.id != null && stated.has(finding.id);
}
