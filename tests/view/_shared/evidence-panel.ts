import { allRows, evidencePanel, type ContentCheck, type EvidencePanel } from '@/view/evidence-panel';
import { evidencePanelFor } from '@/view/detector-registry';
import { emptyAppModel } from '@/store/store';
import type { AppModel, Finding, FindingOf, FindingType } from '@sparkforensics/core/types.ts';

/** A panel for `findings` that keeps every row, for a test of the panel itself (not of a widget's
 * content check). */
export function allRowsPanel<T extends FindingType>(type: T, findings: FindingOf<T>[]): EvidencePanel<T> {
  const panel = evidencePanel(type, allRows, { findings, stated: new Set(), density: 'basic', appModel: emptyAppModel() });
  if (!panel) throw new Error('a test panel needs at least one finding');
  return panel;
}

/** A content check for one finding type, for the type tests. */
export const coldStartContent: ContentCheck<'coldStart'> = ({ findings }) => findings;

/** The rows a widget's content check keeps for `findings` when the line above states `stated`. */
export function keptRows(
  type: FindingType,
  findings: Finding[],
  stated: string[],
  options: { density?: 'basic' | 'advanced'; appModel?: AppModel } = {},
): readonly Finding[] {
  const input = { findings, stated: new Set(stated), density: options.density ?? 'basic', appModel: options.appModel ?? emptyAppModel() };
  return evidencePanelFor(type, input)?.rows ?? [];
}
