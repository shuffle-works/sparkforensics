import { Suspense } from 'react';

import { Table, TableBody } from '@/components/ui/table';
import type { WidgetProps } from '@/view/detector-registry';
import type { BandLayout, BoardLayout } from '@/view/board-layout';
import { bandLandmark, BOARD_LANDMARK, landmarkRowKey } from '@/view/board-layout';
import { useInterpretation } from '@/view/interpretation';
import { useLanding } from '@/view/route-landing';
import type { TriageTarget } from '@/view/triage-target';
import { CleanChecks, SUGGESTED_IMPROVEMENTS_ANCHOR_ID } from '@/view/widgets/Alerts';
import { FindingRow, TypeGroupRow } from '@/view/widgets/FixTheseFirst';
import { WidgetCardSkeleton } from '@/view/WidgetCard';
import { useStore } from '@/store/store';
import { WidgetGrid, WidgetGridItem } from '@/view/WidgetGrid';

export interface ImpactBoardProps {
  layout: BoardLayout;
  widgetProps: WidgetProps;
  onRoute: (target: TriageTarget) => void;
}

const IMPACT_BAND_LABEL = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
} as const;

/** One impact band: its recommendation rows as a compact table. Each row has
 * at most one "Show evidence" control, which expands that widget's card in
 * place, scoped to the row's findings. Evidence cards no step or row shows
 * stay in a grid under the table, collapsed. A band with neither row nor card
 * is not in the layout, so it has no heading. */
function ImpactGroup({
  band,
  widgetProps,
  onRoute,
  subheading,
}: {
  band: BandLayout;
  widgetProps: WidgetProps;
  onRoute: (target: TriageTarget) => void;
  /** Whether the band heading is a sub-heading of "More findings". */
  subheading: boolean;
}) {
  const headingId = `impact-band-${band.band}-heading`;
  const Heading = subheading ? 'h3' : 'h2';
  // The top bar's count chip lands on the band it names.
  const landing = useLanding([landmarkRowKey(bandLandmark(band.band))]);
  const revealed = useStore((s) => s.board.revealedCards);
  const cards = band.cards.filter(({ key }) => !band.routeOnlyCardKeys.has(key) || revealed.has(key));
  if (band.rows.length === 0 && cards.length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      {/* Mono uppercase group label (Trace): the band reads from the tags below it. */}
      <Heading ref={landing} id={headingId} tabIndex={-1} className="trace-eyebrow scroll-mt-20 rounded-sm px-1 pt-2 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {IMPACT_BAND_LABEL[band.band]}
      </Heading>
      {band.rows.length > 0 && (
        <Table className="findings-table">
          <TableBody>
            {band.rows.map((row) => (row.kind === 'finding'
              ? <FindingRow key={row.lineKey} row={row} widgetProps={widgetProps} />
              : <TypeGroupRow key={row.lineKey} row={row} widgetProps={widgetProps} onRoute={onRoute} />))}
          </TableBody>
        </Table>
      )}
      {cards.length > 0 && (
        <WidgetGrid>
          {cards.map(({ key, widget: { component: Widget } }) => (
            <WidgetGridItem key={key} cardId={key}>
              <Suspense fallback={<WidgetCardSkeleton />}>
                <Widget {...widgetProps} defaultCollapsed />
              </Suspense>
            </WidgetGridItem>
          ))}
        </WidgetGrid>
      )}
    </section>
  );
}

/** The Findings tab body: "More findings", the findings the verdict's steps do
 * not lead with, grouped by impact band (Critical → Warning → Info) with their
 * evidence expandable in place, followed by the Clean checks disclosure. The
 * run-level verdict (where to start, and the clean-run message) sits above
 * the tabs in `RunVerdict`. */
export function ImpactBoard({ layout, widgetProps, onRoute }: ImpactBoardProps) {
  const interpretation = useInterpretation();
  const landing = useLanding([landmarkRowKey(BOARD_LANDMARK)]);
  // With the verdict's steps taken out, "More findings" is what is left; a
  // board with nothing left says so instead of showing an empty list.
  const hasVerdictLeads = layout.verdictLeads.size > 0;
  const nothingLeft = layout.listedCount === 0;
  return (
    <div ref={landing} id={SUGGESTED_IMPROVEMENTS_ANCHOR_ID} tabIndex={-1} className="space-y-6 scroll-mt-20 outline-none">
      {hasVerdictLeads ? (
        nothingLeft ? (
          <p data-testid="no-more-findings" className="text-sm text-muted-foreground">No more findings to show.</p>
        ) : (
          <h2 data-testid="more-findings-heading" className="font-heading text-base font-semibold">
            More findings <span className="font-mono text-xs font-normal text-muted-foreground tabular-nums">({layout.listedCount})</span>
          </h2>
        )
      ) : null}
      {layout.bands.map((band) => (
        <ImpactGroup key={band.band} band={band} widgetProps={widgetProps} onRoute={onRoute} subheading={hasVerdictLeads} />
      ))}
      {interpretation ? <CleanChecks activeTypes={layout.evidenceTypes} coverage={interpretation.data.coverage} detectors={interpretation.data.detectors} /> : null}
    </div>
  );
}
