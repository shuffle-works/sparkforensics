import { Suspense, useLayoutEffect, useMemo, useState } from 'react';

import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import type { WidgetProps } from '@/view/detector-registry';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGridItem } from '@/view/WidgetGrid';
import type { ActiveWidget } from '@/view/widgets/Alerts';

/** Open state for the in-place evidence of `scope`, the findings it is for. A
 * route that targets one of them (stage dialog, Stage Summary, a group
 * member's row) opens it too, and it stays open after the route completes. */
export function useEvidenceOpen(widgetId: string | null, scope: readonly Finding[]) {
  const [open, setOpen] = useState(false);
  const routeTarget = useActiveRouteTarget();
  const routedHere = widgetId != null && routeTarget?.widgetId === widgetId && scope.includes(routeTarget.finding);
  useLayoutEffect(() => {
    if (routedHere) setOpen(true);
  }, [routedHere]);
  return { open: open || routedHere, toggle: () => setOpen((value) => !(value || routedHere)) };
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
