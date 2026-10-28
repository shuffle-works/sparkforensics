import { Suspense, useContext, useLayoutEffect, useMemo, useState } from 'react';

import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { EvidenceInitiallyOpenContext, EvidencePanelOwnerContext, InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import type { WidgetProps } from '@/view/detector-registry';
import { TriageNavigationScope, useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGridItem } from '@/view/WidgetGrid';
import type { ActiveWidget } from '@/view/widgets/Alerts';

/** Open state for the in-place evidence of `scope`, the findings it is for. A
 * route that targets one of them (stage dialog, Stage Summary, a group
 * member's row) opens it too, and it stays open after the route completes.
 * The panel renders off screen until it reports whether it is blank; a blank
 * panel offers no toggle and never shows. */
export function useEvidenceOpen(widgetId: string | null, scope: readonly Finding[]) {
  const initiallyOpen = useContext(EvidenceInitiallyOpenContext);
  const [open, setOpen] = useState(initiallyOpen);
  const [blank, setBlank] = useState<boolean | null>(null);
  const routeTarget = useActiveRouteTarget();
  const routedHere = widgetId != null && routeTarget?.widgetId === widgetId && scope.includes(routeTarget.finding);
  useLayoutEffect(() => {
    if (routedHere) setOpen(true);
  }, [routedHere]);
  const shown = (open || routedHere) && blank !== true;
  const owner = useMemo(() => ({ shown, reportBlank: setBlank }), [shown]);
  return {
    open: open || routedHere,
    available: blank !== true,
    mounted: shown || blank === null,
    owner,
    toggle: () => setOpen((value) => !(value || routedHere)),
  };
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
  const owner = useContext(EvidencePanelOwnerContext);
  const reportBlank = owner?.reportBlank;
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
  const state = useMemo(() => ({ stated: new Set(statedKey ? statedKey.split('\n') : []), band, reportBlank }), [statedKey, band, reportBlank]);
  return (
    <InlineEvidenceContext.Provider value={state}>
      <TriageNavigationScope enabled={owner?.shown ?? true}>
        <WidgetGridItem cardId={scope[0]?.id ? `alert-${index}-${scope[0].id}` : `alert-${index}`} widgetId={widgetId} holds={(finding) => scope.includes(finding)}>
          <Suspense fallback={<WidgetCardSkeleton />}>
            <Widget {...widgetProps} {...scoped} defaultCollapsed={false} />
          </Suspense>
        </WidgetGridItem>
      </TriageNavigationScope>
    </InlineEvidenceContext.Provider>
  );
}
