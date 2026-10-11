import { Suspense, useLayoutEffect, useState } from 'react';

import type { WidgetProps } from '@/view/detector-registry';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGridItem } from '@/view/WidgetGrid';
import type { ActiveWidget } from '@/view/widgets/Alerts';

/** Open state for a finding's in-place evidence. A route that targets the
 * evidence's widget (stage dialog, shortcuts, a duplicate "Show evidence")
 * opens it too, and stays open after the route completes. */
export function useEvidenceOpen(widgetId: string | null) {
  const [open, setOpen] = useState(false);
  const routeTarget = useActiveRouteTarget();
  const routedHere = widgetId != null && routeTarget?.widgetId === widgetId;
  useLayoutEffect(() => {
    if (routedHere) setOpen(true);
  }, [routedHere]);
  return { open: open || routedHere, toggle: () => setOpen((value) => !(value || routedHere)) };
}

/** A finding's evidence card, rendered open in the place that asked for it.
 * It registers as the widget's route target like any grid card. */
export function InlineEvidence({ widget, widgetProps }: { widget: ActiveWidget; widgetProps: WidgetProps }) {
  const { component: Widget, widgetId, index } = widget;
  return (
    <WidgetGridItem cardId={`alert-${index}`} widgetId={widgetId}>
      <Suspense fallback={<WidgetCardSkeleton />}>
        <Widget {...widgetProps} />
      </Suspense>
    </WidgetGridItem>
  );
}
