import type { Finding } from '@sparkforensics/core/types';
import { useBoardLayout } from '@/view/BoardLayoutContext';
import { useLanding, useRouteFlash } from '@/view/route-landing';

export interface AnchoredRow {
  ref: (element: HTMLElement | null) => void;
  tabIndex: -1;
  dataFlashed: 'true' | 'false';
  flashClassName: string;
}

const NO_KEYS: readonly string[] = [];

/** What a row that stands for one or more findings (some widgets group several finding types, e.g.
 * skew + stageShape + tinyTask, onto a single row) needs to be a route landing: the ref that takes
 * focus when a route targets any of them, the fixed `tabIndex={-1}` (a route focuses the row itself;
 * -1 keeps it programmatically focusable without adding it to Tab order), `data-flashed` for tests,
 * and the flash className to append to the row's own layout classes. The row's keys are the core
 * `findingKey`s the board layout gives its findings; outside a board the row is not a landing. */
export function useAnchoredRow(findings: readonly Finding[]): AnchoredRow {
  const layout = useBoardLayout();
  const keys = layout ? findings.map(layout.keyOf) : NO_KEYS;
  const ref = useLanding(keys);
  const flashed = useRouteFlash(keys);
  return { ref, tabIndex: -1, dataFlashed: flashed ? 'true' : 'false', flashClassName: flashed ? 'route-flash' : '' };
}

/** Single row-separator convention: one border direction, so widgets don't
 * split between border-b and border-t. Append after the row's own spacing
 * classes, e.g. `space-y-2 ${ROW_SEPARATOR_CLASS}`. */
export const ROW_SEPARATOR_CLASS = 'border-b border-border pb-3 last:border-b-0 last:pb-0';
