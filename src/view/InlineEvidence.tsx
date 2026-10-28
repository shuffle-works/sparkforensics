import { Suspense, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { useWidgetDensity } from '@/store/store';
import { EvidenceInitiallyOpenContext, InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import type { WidgetProps } from '@/view/detector-registry';
import { useActiveRouteTarget, useTriageNavigation } from '@/view/TriageNavigationContext';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGridItem } from '@/view/WidgetGrid';
import type { ActiveWidget } from '@/view/widgets/Alerts';

/** Open state for the in-place evidence of `scope`, the findings it is for. A
 * route that targets one of them (stage dialog, Stage Summary, a group
 * member's row) opens it too, and it stays open after the route completes. */
export function useEvidenceOpen(widgetId: string | null, scope: readonly Finding[]) {
  const initiallyOpen = useContext(EvidenceInitiallyOpenContext);
  const [open, setOpen] = useState(initiallyOpen);
  const routeTarget = useActiveRouteTarget();
  const routedHere = widgetId != null && routeTarget?.widgetId === widgetId && scope.includes(routeTarget.finding);
  useLayoutEffect(() => {
    if (routedHere) setOpen(true);
  }, [routedHere]);
  return { open: open || routedHere, toggle: () => setOpen((value) => !(value || routedHere)) };
}

/** Whether `widget` has anything to show for `scope` beyond what the line above states (`stated`).
 * The host shows the evidence control and the panel only when it does. True for a finding with no
 * active widget, which the host routes instead. */
export function widgetHasEvidence(
  widget: ActiveWidget | null | undefined,
  appModel: AppModel | undefined,
  scope: readonly Finding[],
  stated: readonly Finding[],
  advanced: boolean,
): boolean {
  if (!widget?.hasEvidence || !appModel) return true;
  const ids = new Set(stated.flatMap((finding) => (finding.id != null ? [finding.id] : [])));
  return widget.hasEvidence({ findings: scope, stated: ids, advanced, appModel });
}

/** `widgetHasEvidence` at the current widget density, so a host re-checks when the density changes. */
export function useHasEvidence(
  widget: ActiveWidget | null | undefined,
  appModel: AppModel | undefined,
  scope: readonly Finding[],
  stated: readonly Finding[],
): boolean {
  return widgetHasEvidence(widget, appModel, scope, stated, useWidgetDensity() === 'advanced');
}

/** Lets a route to a finding of `widgetId` land on the step or row that has no evidence panel:
 * `wrapper` scrolls into view and `focusTarget` takes focus, as an evidence panel's title does. */
export function useRouteLanding(
  widgetId: string | null,
  scope: readonly Finding[],
  wrapper: RefObject<HTMLElement | null>,
  focusTarget: RefObject<HTMLElement | null>,
): void {
  const navigation = useTriageNavigation();
  const focusKey = useId();
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useLayoutEffect(() => {
    const element = wrapper.current;
    if (!navigation || !widgetId || !element) return;
    return navigation.registerWidget(widgetId, {
      wrapperElement: element,
      // Nothing opens: the route lands as soon as it is asked to.
      open: () => navigation.reportWidgetOpen(widgetId, true),
      getDisclosureButton: () => focusTarget.current,
      holds: (finding) => scopeRef.current.includes(finding),
      focusKey,
    });
  }, [navigation, widgetId, focusKey, wrapper, focusTarget]);
}

/** A finding's evidence, rendered open in the place that asked for it: the
 * widget's top card takes its flat panel form and leaves out what `stated`, the
 * findings the line above it already describes, repeats. It registers as the
 * route target for the findings in its `scope`. */
export function InlineEvidence({
  widget,
  widgetProps,
  stated = [],
  scope,
}: {
  widget: ActiveWidget;
  widgetProps: WidgetProps;
  stated?: readonly Finding[];
  /** The findings this panel is for. The widget renders without its other findings of the same
   * type, so a second finding of a type gets its own panel under its own line. */
  scope: readonly Finding[];
}) {
  const { component: Widget, widgetId, index } = widget;
  const { catalog, configFindings } = widgetProps;
  const scoped = useMemo(() => {
    const others = new Set(widget.findings.filter((finding) => !scope.includes(finding)));
    return {
      catalog: catalog.filter((finding) => !others.has(finding)),
      configFindings: configFindings?.filter((finding) => !others.has(finding)),
    };
  }, [scope, widget.findings, catalog, configFindings]);
  const statedIds = stated.flatMap((finding) => (finding.id != null ? [finding.id] : []));
  const band = worstImpactBand([...stated]);
  const statedKey = statedIds.join('\n');
  const state = useMemo(() => ({ stated: new Set(statedKey ? statedKey.split('\n') : []), band }), [statedKey, band]);
  return (
    <InlineEvidenceContext.Provider value={state}>
      <WidgetGridItem cardId={scope[0]?.id ? `alert-${index}-${scope[0].id}` : `alert-${index}`} widgetId={widgetId} holds={(finding) => scope.includes(finding)}>
        <Suspense fallback={<WidgetCardSkeleton />}>
          <Widget {...widgetProps} {...scoped} defaultCollapsed={false} />
        </Suspense>
      </WidgetGridItem>
    </InlineEvidenceContext.Provider>
  );
}
