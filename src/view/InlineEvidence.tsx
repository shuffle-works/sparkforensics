import { Suspense, useMemo } from 'react';

import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { store, useStore } from '@/store/store';
import { InlineEvidenceContext } from '@/view/InlineEvidenceContext';
import type { WidgetProps } from '@/view/detector-registry';
import type { AnyEvidencePanel } from '@/view/evidence-panel';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { WidgetGridItem } from '@/view/WidgetGrid';
import type { ActiveWidget } from '@/view/widgets/Alerts';

/** Whether the board card `cardKey` is open, and a control that flips it. A route to one of the
 * card's findings opens it, and it stays open after the route lands. */
export function useCardOpen(cardKey: string | null) {
  const open = useStore((s) => cardKey != null && s.board.openCards.has(cardKey));
  return { open, toggle: () => { if (cardKey != null) store.getState().setCardOpen(cardKey, !open); } };
}

/** A panel's evidence, rendered open in the place that asked for it: the widget's top card takes
 * its flat panel form and leaves out what `stated`, the findings the line above it already
 * describes, repeats. It shows the panel's rows only, and is the board card `cardKey`. It takes an
 * `EvidencePanel`, which only the widget's content check makes. */
export function InlineEvidence({
  widget,
  widgetProps,
  stated = [],
  panel,
  cardKey,
}: {
  widget: ActiveWidget;
  widgetProps: WidgetProps;
  stated?: readonly Finding[];
  panel: AnyEvidencePanel;
  cardKey: string;
}) {
  const { component: Widget } = widget;
  const { catalog, configFindings } = widgetProps;
  // The widget renders without its other findings of the same type, so a second finding of a type
  // gets its own panel under its own line.
  const scope: readonly Finding[] = panel.rows;
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
      <WidgetGridItem cardId={cardKey}>
        <Suspense fallback={<WidgetCardSkeleton />}>
          <Widget {...widgetProps} {...scoped} defaultCollapsed={false} />
        </Suspense>
      </WidgetGridItem>
    </InlineEvidenceContext.Provider>
  );
}
