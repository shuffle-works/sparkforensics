import { memo, useMemo } from 'react';
import { Bar, CartesianGrid, ComposedChart, Legend, Rectangle, Tooltip, XAxis, YAxis } from 'recharts';
import type { BarShapeProps } from 'recharts';

import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { DocsLink } from '@/view/DocsContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '../WidgetCard';
import { WidgetLeadSummary } from '../WidgetLeadSummary';
import { CHART_COLORS, ChartFrame } from '../charts/ChartTheme';
import { downsample } from '../charts/downsample';

const TARGET_BUCKETS = 60;
const MIN_BUCKET_MS = 60_000; // 1 minute floor
const HEIGHT = 220;

export interface ChurnBucket {
  tStart: number;
  adds: number;
  removes: number;
}

// Bucketed executor add/remove counts.
export function bucketChurn(
  added: { timestamp: number }[],
  removed: { timestamp: number }[],
  startTime: number,
  endTime: number,
  bucketWidthMs: number,
): ChurnBucket[] {
  if (added.length === 0 && removed.length === 0) return [];
  const span = Math.max(bucketWidthMs, endTime - startTime);
  const nBuckets = Math.max(1, Math.ceil(span / bucketWidthMs));
  const buckets: ChurnBucket[] = [];
  for (let i = 0; i < nBuckets; i++) buckets.push({ tStart: startTime + i * bucketWidthMs, adds: 0, removes: 0 });
  const idx = (t: number) => Math.min(nBuckets - 1, Math.max(0, Math.floor((t - startTime) / bucketWidthMs)));
  for (const e of added) buckets[idx(e.timestamp)].adds++;
  for (const e of removed) buckets[idx(e.timestamp)].removes++;
  return buckets;
}

function chooseBucketWidth(startTime: number, endTime: number): number {
  const span = Math.max(1, endTime - startTime);
  return Math.max(MIN_BUCKET_MS, Math.ceil(span / TARGET_BUCKETS));
}

// Round up to a "nice" 1/2/5/10 * 10^n number so the y-axis shows round steps
// (e.g. 200/100/0/-100/-200); Recharts' auto domain fits data tightly and
// inflates small churn bars near zero until they read as a stray line.
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = 10 ** exponent;
  const frac = value / base;
  const niceFrac = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return niceFrac * base;
}

function computeYAxisScale(rows: ChurnRow[]): { domain: [number, number]; ticks: number[] } {
  const maxAbs = rows.reduce((max, r) => Math.max(max, Math.abs(r.added), Math.abs(r.removed)), 0);
  const niceMax = niceCeil(maxAbs);
  return { domain: [-niceMax, niceMax], ticks: [-niceMax, -niceMax / 2, 0, niceMax / 2, niceMax] };
}

// A sub-pixel-tall rect paints as a crisp full-width sliver that reads as a
// stray line, not a small bar; skip drawing rects that round away to nothing.
function skipSubPixelBars(props: BarShapeProps) {
  return Math.abs(props.height) < 1 ? null : <Rectangle {...props} />;
}

export interface AutoscalingChurnProps {
  appModel: AppModel;
  // `applySnapshot` mutates `appModel`'s fields in place on a cached-file switch
  // rather than replacing the object, so `activeFileId` is a memo key below.
  activeFileId?: string | null;
  // REGISTRY always passes a real `catalog`, but direct test/callers that only
  // want the descriptive chart may omit it (optional, default []).
  catalog?: Finding[];
  defaultCollapsed?: boolean;
}

interface ChurnRow {
  t: string;
  added: number;
  removed: number;
}

type ChurnModel =
  | { hasEvents: false; added: { timestamp: number }[]; removed: { timestamp: number }[] }
  | { hasEvents: true; added: { timestamp: number }[]; removed: { timestamp: number }[]; rows: ChurnRow[]; yAxisScale: ReturnType<typeof computeYAxisScale> };

/** Single-row body for an active `autoscalingChurn` finding: stat line +
 * `ImpactEstimate`, and a recommendation (with tuning link), always visible
 * (there's only ever one active churn finding, so no per-row location is
 * needed). */
function AutoscalingChurnRow({ finding }: { finding: Finding }) {
  return (
    <div className="flex flex-col gap-1 transition-colors">
      <p className="text-xs text-muted-foreground">
        Short-lived executors: <strong>{finding.value}%</strong>
      </p>
      <ImpactEstimate finding={finding} />
      <p className="flex flex-wrap items-start gap-2 text-sm">
        <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
        <span>
          {finding.recommendation}{' '}
          <DocsLink anchor="#config-autoscale-bounds">Tuning executorIdleTimeout and the min/max bounds</DocsLink>.
        </span>
      </p>
    </div>
  );
}

// memo: skip recomputing bucketChurn when only the finding filter changes.
export const AutoscalingChurn = memo(function AutoscalingChurn({ appModel, activeFileId, catalog = [], defaultCollapsed = true }: AutoscalingChurnProps) {
  // Whole derived-series pipeline (including the empty-events guard) in one
  // `useMemo`; hooks run unconditionally, so the early return can't precede it.
  const churn: ChurnModel = useMemo(() => {
    const added = appModel.executors.added;
    const removed = appModel.executors.removed;
    if (added.length === 0 && removed.length === 0) {
      return { hasEvents: false, added, removed };
    }

    const app = appModel.app;
    const startTime = app?.startTime ?? 0;
    const endTime = app?.endTime ?? startTime;
    const width = chooseBucketWidth(startTime, endTime);
    // downsample() is a no-op here (chooseBucketWidth already targets
    // ~TARGET_BUCKETS) but keeps the never-hand-thousands-of-points contract.
    const buckets = downsample(bucketChurn(added, removed, startTime, endTime, width));

    const rows: ChurnRow[] = buckets.map((b) => ({
      t: `${Math.round((b.tStart - startTime) / 1000)}s`,
      added: b.adds,
      removed: -b.removes,
    }));
    const yAxisScale = computeYAxisScale(rows);

    return { hasEvents: true, added, removed, rows, yAxisScale };
  }, [appModel, activeFileId]);

  if (!churn.hasEvents) {
    return (
      <WidgetCard
        title="Autoscaling Churn"
        summary={<span className="text-muted-foreground text-xs">No executor add/remove events (static allocation).</span>}
      >
        <p className="text-muted-foreground text-xs">
          No executor add/remove events (static allocation).
        </p>
      </WidgetCard>
    );
  }
  const { added, removed, rows, yAxisScale } = churn;
  const finding = catalog.find((f) => f.type === 'autoscalingChurn');

  return (
    <WidgetCard
      title="Autoscaling Churn"
      impactBand={finding?.impactBand}
      badges={finding && <TagBadge type="autoscalingChurn" impactBand={finding.impactBand} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${added.length} added / ${removed.length} removed`}
          context={finding ? `${finding.value}% short-lived executors, ${finding.impactBand}` : 'executor churn events'}
        />
      }
    >
      <div className="space-y-2">
        {finding && <AutoscalingChurnRow finding={finding} />}
        <p className="text-muted-foreground text-xs">executors added / removed over time</p>
        <ChartFrame
          ariaLabel="Executor added and removed counts per time bucket over the run."
          height={HEIGHT}
          table={{
            caption: 'Executor added/removed counts by time bucket',
            columns: ['Time', 'Executors added', 'Executors removed'],
            rows: rows.map((r) => [r.t, r.added, Math.abs(r.removed)]),
            align: ['right', 'right', 'right'],
          }}
        >
            <ComposedChart data={rows}>
              <CartesianGrid stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
              <XAxis dataKey="t" tick={{ fontSize: 10 }} />
              <YAxis
                tick={{ fontSize: 10 }}
                width={32}
                domain={yAxisScale.domain}
                ticks={yAxisScale.ticks}
              />
              <Tooltip formatter={(value, name) => [Math.abs(Number(value)), name]} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="added" name="Added" stackId="churn" fill={CHART_COLORS.clean} shape={skipSubPixelBars} />
              {/* Scale-down is normal autoscaling, not a problem: use the muted
                  token, not the critical impact-band color. */}
              <Bar
                dataKey="removed"
                name="Removed"
                stackId="churn"
                fill={CHART_COLORS.muted}
                shape={skipSubPixelBars}
              />
            </ComposedChart>
        </ChartFrame>
      </div>
    </WidgetCard>
  );
});
