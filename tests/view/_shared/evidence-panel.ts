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

/** Whether `node` or an ancestor up to `root` is hidden from view. jsdom loads no stylesheet, so
 * Tailwind's `hidden` class is read by name. */
export function isHidden(node: Element, root: Element): boolean {
  for (let element: Element | null = node; element && element !== root.parentElement; element = element.parentElement) {
    if (element.hasAttribute('hidden') || element.classList.contains('hidden')) return true;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
  }
  return false;
}

/** Whether a rendered evidence panel shows anything besides its title: text, or a chart or a table.
 * Output that is hidden counts as not shown. */
export function showsEvidence(panel: HTMLElement): boolean {
  const body = panel.querySelector('section > div:last-child') as HTMLElement | null;
  if (!body || isHidden(body, panel)) return false;
  const texts = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = texts.nextNode(); node; node = texts.nextNode()) {
    if (node.textContent?.trim() && !isHidden(node.parentElement!, panel)) return true;
  }
  return [...body.querySelectorAll('svg:not([aria-hidden="true"]), table, canvas, img')].some((element) => !isHidden(element, panel));
}
