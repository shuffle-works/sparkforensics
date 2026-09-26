import { useEffect } from 'react';

/** Every focusable finding control on the Findings tab, in reading order:
 * the verdict's per-step "Show evidence" buttons, then each band's
 * recommendation rows (single findings and type groups). */
const FINDING_CONTROL_SELECTOR = [
  '[data-testid="next-step"] [data-shortcut-target]',
  '[data-testid="fix-these-first-row"] button[data-shortcut-target]',
  '[data-testid="fix-these-first-group-row"] button[data-shortcut-target]',
].join(', ');

/** True while the key belongs to something else: typing in a field, a
 * modifier chord, a focused listbox/combobox, or an open dialog/menu/listbox
 * that owns its own keyboard model. */
function shouldIgnore(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return true;
  if (target?.closest?.('[role="listbox"], [role="combobox"]')) return true;
  // A closed Base UI popup can stay mounted under a hidden ancestor, so only
  // a popup that is actually shown owns the keyboard.
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], [role="alertdialog"], [role="listbox"]')]
    .some((popup) => !popup.closest('[hidden]') && popup.getClientRects().length > 0);
}

function visibleControls(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(FINDING_CONTROL_SELECTOR)].filter(
    (element) => element.offsetParent !== null || element.getClientRects().length > 0,
  );
}

/** Moves focus to the next (+1) or previous (-1) finding control, starting
 * from the focused one, or from the top when focus is elsewhere. */
export function moveFindingFocus(direction: 1 | -1): HTMLElement | null {
  const controls = visibleControls();
  if (controls.length === 0) return null;
  const current = controls.indexOf(document.activeElement as HTMLElement);
  const nextIndex = current === -1
    ? (direction === 1 ? 0 : controls.length - 1)
    : Math.min(controls.length - 1, Math.max(0, current + direction));
  const next = controls[nextIndex];
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  next.focus({ preventScroll: true });
  next.scrollIntoView?.({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' });
  return next;
}

export interface TriageShortcutHandlers {
  /** Only Advanced view turns these on. Single-character shortcuts must have
   * an off switch (WCAG 2.1.4) and must not surprise a newcomer, so Basic
   * view, the default, never binds them. */
  enabled: boolean;
  showFindings: () => void;
  showFullReport: () => void;
}

/** Single-key triage shortcuts for the run dashboard in Advanced view,
 * documented in `KeyboardShortcutsDialog`: j/k step through findings (verdict
 * steps, then every recommendation row) and Enter shows the focused one's
 * evidence or expands a grouped finding, f jumps to the finding filters, 1/2 switch the report tabs. */
export function useTriageShortcuts({ enabled, showFindings, showFullReport }: TriageShortcutHandlers): void {
  useEffect(() => {
    if (!enabled) return undefined;
    function onKeyDown(event: KeyboardEvent) {
      if (shouldIgnore(event)) return;
      switch (event.key) {
        case 'j':
        case 'k': {
          const direction = event.key === 'j' ? 1 : -1;
          event.preventDefault();
          showFindings();
          // The Findings panel may only become visible on the next render.
          requestAnimationFrame(() => moveFindingFocus(direction));
          return;
        }
        case 'f': {
          const firstFilter = document.querySelector<HTMLElement>('[aria-label="Filter findings"] button');
          if (!firstFilter) return;
          event.preventDefault();
          firstFilter.focus();
          return;
        }
        case '1':
          showFindings();
          event.preventDefault();
          return;
        case '2':
          showFullReport();
          event.preventDefault();
          return;
        default:
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, showFindings, showFullReport]);
}
