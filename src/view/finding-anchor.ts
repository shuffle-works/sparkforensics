import { useCallback, useRef } from 'react';

import { findingKey, type FindingLocator } from '@sparkforensics/core/finding-identity.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useRouteFlashedFinding, useTriageNavigation } from './TriageNavigationContext';

/**
 * Ref callback for a row/element that represents one or more findings (some
 * widgets group several finding types, e.g. skew + stageShape + tinyTask,
 * onto a single row). Registers the mounted element under every finding in
 * `findings` so a triage badge for any of them routes here.
 *
 * Anchors are keyed by the core `findingKey`, so a finding of another run lands on the
 * row that shows the same finding. Re-registers only when the group's keys (joined,
 * order-sensitive) change, not on every render: widgets frequently rebuild the
 * `findings` array with new-but-equivalent objects. Cleanup runs via the element
 * itself changing/unmounting or the callback identity changing (React calls the
 * previous ref callback with `null` first), so a `useRef`-held list of unregister
 * functions survives across those calls.
 */
export function useFindingAnchor(findings: Finding[]): (element: HTMLElement | null) => void {
  const navigation = useTriageNavigation();
  const keys = navigation ? findings.map(navigation.findingKey) : [];
  const signature = keys.join(',');
  const unregisterFns = useRef<Array<() => void>>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands in for `keys`; see the doc comment.
  return useCallback(
    (element: HTMLElement | null) => {
      unregisterFns.current.forEach((unregister) => unregister());
      unregisterFns.current = [];

      if (element && navigation) {
        unregisterFns.current = keys.map((key) => navigation.registerFindingAnchor(key, element));
      }
    },
    [signature, navigation],
  );
}

/** Whether the currently route-flashed finding is one of this row's `findings` (by reference). */
export function useIsRouteFlash(findings: Finding[]): boolean {
  const flashedFinding = useRouteFlashedFinding();
  return flashedFinding !== null && findings.includes(flashedFinding);
}

/** `className` fragment for a route-flashed row; append to the row's own layout classes. */
export function flashRowClassName(isFlashed: boolean): string {
  return isFlashed ? 'bg-primary/10 ring-2 ring-primary rounded-md' : '';
}

// A stage or execution is named by its id: the anchors of one run need no label shared with another.
const RUN_LOCATOR: FindingLocator = { stage: (id) => `#${id}`, execution: (id) => `#${id}` };

/** The core `findingKey` of each finding of a run, made unique: findings that share a key take their
 * order among them as a suffix, so each keeps its own row. */
export function runFindingKeys(findings: Finding[]): (finding: Finding) => string {
  const keyOf = (finding: Finding) => findingKey(finding, RUN_LOCATOR);
  const keys = new Map<Finding, string>();
  const seen = new Map<string, number>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    keys.set(finding, n === 0 ? key : `${key}#${n}`);
  }
  return (finding) => keys.get(finding) ?? keyOf(finding);
}

export interface AnchoredRow {
  ref: (element: HTMLElement | null) => void;
  tabIndex: -1;
  dataFlashed: 'true' | 'false';
  flashClassName: string;
}

/** Combines `useFindingAnchor` + `useIsRouteFlash` into the one bundle every
 * anchored row needs: the ref callback, the fixed `tabIndex={-1}` (a triage
 * route focuses the row itself; -1 keeps it programmatically focusable without
 * adding it to Tab order), `data-flashed` for tests, and the flash className
 * fragment to append to the row's own layout classes. */
export function useAnchoredRow(findings: Finding[]): AnchoredRow {
  const ref = useFindingAnchor(findings);
  const isFlashed = useIsRouteFlash(findings);
  return { ref, tabIndex: -1, dataFlashed: isFlashed ? 'true' : 'false', flashClassName: flashRowClassName(isFlashed) };
}

/** Single row-separator convention: one border direction, so widgets don't
 * split between border-b and border-t. Append after the row's own spacing
 * classes, e.g. `space-y-2 ${ROW_SEPARATOR_CLASS}`. */
export const ROW_SEPARATOR_CLASS = 'border-b border-border pb-3 last:border-b-0 last:pb-0';
