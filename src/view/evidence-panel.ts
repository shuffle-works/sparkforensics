import type { AppModel, Finding, FindingOf, FindingType } from '@sparkforensics/core/types.ts';

/** What decides whether a widget has anything to show in an evidence panel. */
export interface PanelInput<T extends FindingType> {
  /** The findings the panel is for. */
  findings: readonly FindingOf<T>[];
  /** Ids of the findings the line above the panel states. */
  stated: ReadonlySet<string>;
  density: 'basic' | 'advanced';
  appModel: AppModel;
}

/** The rows a widget shows in a panel, decided before anything renders. No rows means no panel and
 * no evidence control. The widget renders only these rows, so the check and the panel are one
 * decision. */
export type ContentCheck<T extends FindingType> = (input: PanelInput<T>) => readonly FindingOf<T>[];

declare const panelBrand: unique symbol;

/** A panel with at least one row to show. Only `evidencePanel` makes one, so the evidence control,
 * the panel and its route target cannot exist for a widget that has nothing to show. */
export interface EvidencePanel<T extends FindingType> {
  readonly [panelBrand]: true;
  readonly type: T;
  readonly rows: readonly FindingOf<T>[];
}

/** `EvidencePanel` of any one finding type. A plain `EvidencePanel<FindingType>` is invariant. */
export type AnyEvidencePanel = { [T in FindingType]: EvidencePanel<T> }[FindingType];

/** The one constructor: the panel `check` keeps rows for, or null when it keeps none. */
export function evidencePanel<T extends FindingType>(type: T, check: ContentCheck<T>, input: PanelInput<T>): EvidencePanel<T> | null {
  const rows = check(input);
  return rows.length > 0 ? ({ type, rows } as unknown as EvidencePanel<T>) : null;
}

export function isStated(finding: Finding, stated: ReadonlySet<string>): boolean {
  return finding.id != null && stated.has(finding.id);
}

/** The check of a widget whose rows show everything. */
export function allRows<T extends FindingType>({ findings }: PanelInput<T>): readonly FindingOf<T>[] {
  return findings;
}

/** The check of a widget whose rows are only what the line above states: a stated finding has
 * nothing left to show. */
export function unstatedRows<T extends FindingType>({ findings, stated }: PanelInput<T>): readonly FindingOf<T>[] {
  return findings.filter((finding) => !isStated(finding, stated));
}
