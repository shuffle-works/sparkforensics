import { useEffect } from 'react';

import { store } from '@/store/store';
import { FILTERS_LANDMARK, walkableLines, type BoardLayout } from '@/view/board-layout';
import { routeTo } from '@/view/route-landing';

/** True while the key belongs to something else: typing in a field, a modifier chord, or a focused
 * dialog, menu or listbox that owns its own keyboard model (they trap focus, so their keys start
 * inside them). */
function shouldIgnore(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return true;
  return target?.closest?.('[role="listbox"], [role="combobox"], [role="dialog"], [role="alertdialog"], [role="menu"]') != null;
}

/** The line to focus after the one holding focus, stepping `direction` through the layout's lines. */
function lineAfter(layout: BoardLayout, direction: 1 | -1): string | null {
  const { cursor, expandedGroup } = store.getState().board;
  const lines = walkableLines(layout, expandedGroup);
  if (lines.length === 0) return null;
  const current = cursor == null ? -1 : lines.indexOf(cursor);
  if (current === -1) return direction === 1 ? lines[0] : lines[lines.length - 1];
  return lines[Math.min(lines.length - 1, Math.max(0, current + direction))];
}

export interface TriageShortcutHandlers {
  /** Only Advanced view turns these on. Single-character shortcuts must have
   * an off switch (WCAG 2.1.4) and must not surprise a newcomer, so Basic
   * view, the default, never binds them. */
  enabled: boolean;
  layout: BoardLayout;
}

/** Single-key triage shortcuts for the run dashboard in Advanced view,
 * documented in `KeyboardShortcutsDialog`: j/k step through the layout's lines (verdict steps, then
 * every recommendation row) and Enter shows the focused one's evidence or expands a grouped
 * finding, f jumps to the finding filters, 1/2 switch the report tabs. */
export function useTriageShortcuts({ enabled, layout }: TriageShortcutHandlers): void {
  useEffect(() => {
    if (!enabled) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnore(event)) return;
      const { selectTab, startRoute } = store.getState();
      switch (event.key) {
        case 'j':
        case 'k': {
          event.preventDefault();
          const next = lineAfter(layout, event.key === 'j' ? 1 : -1);
          if (next) startRoute({ tab: 'findings', openCards: [], cardKey: null, rowKey: next }, { flash: false, block: 'nearest' });
          else selectTab('findings');
          return;
        }
        case 'f':
          if (routeTo(layout, { kind: 'landmark', id: FILTERS_LANDMARK })) event.preventDefault();
          return;
        case '1':
          selectTab('findings');
          event.preventDefault();
          return;
        case '2':
          selectTab('full-report');
          event.preventDefault();
          return;
        default:
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, layout]);
}
