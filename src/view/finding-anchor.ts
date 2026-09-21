import { useCallback, useRef } from 'react';

import type { Finding } from '@sparkforensics/core/types.ts';
import { useRouteFlashedFinding, useTriageNavigation } from './TriageNavigationContext';

/** Stable per-finding key, order-sensitive so a reordered group re-registers too. */
function findingSignature(findings: Finding[]): string {
  return findings.map((finding) => `${finding.type}:${finding.stageId}`).join(',');
}

/**
 * Ref callback for a row/element that represents one or more findings (some
 * widgets group several finding types, e.g. skew + stageShape + tinyTask,
 * onto a single row). Registers the mounted element under every finding in
 * `findings` so a triage badge for any of them routes here.
 *
 * Re-registers only when the *signature* of the group (each finding's
 * `type:stageId`, joined) changes, not on every render: widgets frequently
 * rebuild the `findings` array with new-but-equivalent objects. Cleanup runs
 * via the element itself changing/unmounting or the callback identity
 * changing (React calls the previous ref callback with `null` first), so a
 * `useRef`-held list of unregister functions survives across those calls.
 */
export function useFindingAnchor(findings: Finding[]): (element: HTMLElement | null) => void {
  const navigation = useTriageNavigation();
  const signature = findingSignature(findings);
  const unregisterFns = useRef<Array<() => void>>([]);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- `signature` stands in for `findings`; see the doc comment.
  return useCallback(
    (element: HTMLElement | null) => {
      unregisterFns.current.forEach((unregister) => unregister());
      unregisterFns.current = [];

      if (element && navigation) {
        unregisterFns.current = findings.map((finding) => navigation.registerFindingAnchor(finding, element));
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

export interface AnchoredRow {
  ref: (element: HTMLElement | null) => void;
  tabIndex: -1;
  dataFlashed: 'true' | 'false';
  flashClassName: string;
}

/** Combines `useFindingAnchor` + `useIsRouteFlash` into the one bundle every
 * anchored row needs: the ref callback, the fixed `tabIndex={-1}` (findings
 * are reached via triage routing, not tab order), `data-flashed` for tests,
 * and the flash className fragment to append to the row's own layout classes. */
export function useAnchoredRow(findings: Finding[]): AnchoredRow {
  const ref = useFindingAnchor(findings);
  const isFlashed = useIsRouteFlash(findings);
  return { ref, tabIndex: -1, dataFlashed: isFlashed ? 'true' : 'false', flashClassName: flashRowClassName(isFlashed) };
}

/** Single row-separator convention: one border direction, so widgets don't
 * split between border-b and border-t. Append after the row's own spacing
 * classes, e.g. `space-y-2 ${ROW_SEPARATOR_CLASS}`. */
export const ROW_SEPARATOR_CLASS = 'border-b border-border pb-3 last:border-b-0 last:pb-0';
