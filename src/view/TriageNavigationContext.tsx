import { createContext, useContext, useMemo, type ReactNode } from 'react';

import type { Finding } from '@sparkforensics/core/types.ts';
import type { TriageTarget } from './triage-target';

export interface WidgetRegistration {
  wrapperElement: HTMLDivElement;
  open: () => void;
  /** Returns the card's actual disclosure button (WidgetCard.tsx's
   * CollapsibleTrigger) when the card is collapsible, or null when it renders
   * a static, non-collapsible `<h3>` instead. Used by route navigation to
   * scroll to and focus a widget it jumps to. */
  getDisclosureButton: () => HTMLButtonElement | null;
}

export interface TriageNavigation {
  registerWidget: (widgetId: string, registration: WidgetRegistration) => () => void;
  registerFindingAnchor: (finding: Finding, element: HTMLElement) => () => void;
  reportWidgetOpen: (widgetId: string, open: boolean) => void;
  clearRouteFocus: (widgetId: string) => void;
}

const TriageNavigationContext = createContext<TriageNavigation | null>(null);
// Route focus lives in its own context: it changes on every focus/blur, while
// the imperative `TriageNavigation` value must stay referentially stable so
// widget registration (keyed on `navigation`) doesn't tear down and re-register
// on each focus change.
const RouteFocusContext = createContext<string | null>(null);
// Same split-for-stability rationale as `RouteFocusContext`: the active route
// target and the currently-flashed finding change on every route/flash, so
// they live in their own contexts rather than the memoized `TriageNavigation`
// bundle.
const ActiveRouteTargetContext = createContext<TriageTarget | null>(null);
const RouteFlashContext = createContext<Finding | null>(null);

export function TriageNavigationProvider({
  children,
  registerWidget,
  registerFindingAnchor,
  reportWidgetOpen,
  clearRouteFocus,
  focusedWidgetId,
  activeRouteTarget,
  flashedFinding,
}: TriageNavigation & {
  children: ReactNode;
  focusedWidgetId: string | null;
  activeRouteTarget: TriageTarget | null;
  flashedFinding: Finding | null;
}) {
  const value = useMemo(
    () => ({ registerWidget, registerFindingAnchor, reportWidgetOpen, clearRouteFocus }),
    [registerWidget, registerFindingAnchor, reportWidgetOpen, clearRouteFocus],
  );

  return (
    <TriageNavigationContext.Provider value={value}>
      <RouteFocusContext.Provider value={focusedWidgetId}>
        <ActiveRouteTargetContext.Provider value={activeRouteTarget}>
          <RouteFlashContext.Provider value={flashedFinding}>
            {children}
          </RouteFlashContext.Provider>
        </ActiveRouteTargetContext.Provider>
      </RouteFocusContext.Provider>
    </TriageNavigationContext.Provider>
  );
}

export function useTriageNavigation() {
  return useContext(TriageNavigationContext);
}

export function useRouteFocusedWidgetId() {
  return useContext(RouteFocusContext);
}

export function useActiveRouteTarget() {
  return useContext(ActiveRouteTargetContext);
}

export function useRouteFlashedFinding() {
  return useContext(RouteFlashContext);
}
