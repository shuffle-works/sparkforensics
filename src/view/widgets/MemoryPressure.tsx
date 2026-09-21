import { CircleCheck } from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  Scatter,
  ScatterChart,
  Tooltip,
  type TooltipContentProps,
  XAxis,
  YAxis,
} from 'recharts';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { AppModel, ImpactBand } from '@sparkforensics/core/types.ts';
import { DocsLink } from '@/view/DocsContext';
import { EmptyState } from '@/view/EmptyState';
import { ImpactDot } from '@/view/ImpactBadge';
import { CHART_COLORS, ChartFrame } from '../charts/ChartTheme';
import { downsample } from '../charts/downsample';
import { formatBytes } from '@sparkforensics/core/format-utils.ts';

const HEIGHT = 240;

// Thresholds for this widget's own scatter coloring, deliberately not the
// detector `spill`/`gc` thresholds (which serve a different, stage-scoped
// detection purpose).
const SPILL_BAD_BYTES = 500 * 1024 * 1024;
const GC_BAD_PCT = 10;

interface MemoryPressurePoint {
  stageId: number;
  spillBytes: number;
  gcPct: number;
  submittedAt: number;
}

function impactLevel(point: MemoryPressurePoint): ImpactBand {
  const spillBad = point.spillBytes > SPILL_BAD_BYTES;
  const gcBad = point.gcPct > GC_BAD_PCT;
  if (spillBad && gcBad) return 'critical';
  if (spillBad || gcBad) return 'warning';
  return 'info';
}

function impactColor(point: MemoryPressurePoint): string {
  return CHART_COLORS[impactLevel(point)];
}

// Custom tooltip so the impact-band read driving the point's color (invisible to
// colorblind users) is surfaced as its own line, in ImpactBadge's ALL-CAPS
// vocabulary.
function ScatterTooltipContent({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as MemoryPressurePoint | undefined;
  if (!point) return null;
  const impactBand = impactLevel(point);
  return (
    <div className="rounded-md border border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground shadow-md">
      <p>{formatBytes(point.spillBytes)} spilled</p>
      <p>{point.gcPct.toFixed(1)}% GC</p>
      <p className="mt-1 flex items-center gap-1.5 font-medium">
        <ImpactDot impactBand={impactBand} />
        {impactBand.toUpperCase()}
      </p>
    </div>
  );
}

export interface MemoryPressureProps {
  appModel: AppModel;
}

export function MemoryPressure({ appModel }: MemoryPressureProps) {
  const points: MemoryPressurePoint[] = [];
  for (const stage of appModel.stages.values()) {
    const spillBytes = stage.memoryBytesSpilled ?? 0;
    if (spillBytes <= 0) continue; // only stages that spilled carry signal here
    points.push({
      stageId: stage.id,
      spillBytes,
      gcPct: stage.gcPct ?? 0,
      submittedAt: stage.submittedAt ?? 0,
    });
  }

  if (points.length === 0) {
    return <EmptyState tone="clean" icon={CircleCheck} title="No stages spilled memory in this run." />;
  }

  const sampled = downsample(points);
  const twinData = [...sampled]
    .sort((a, b) => a.submittedAt - b.submittedAt)
    .map((p) => ({ stage: `S${p.stageId}`, spillMB: p.spillBytes / (1024 * 1024), gcPct: p.gcPct }));

  return (
    <Tabs defaultValue="scatter">
      <TabsList aria-label="Memory pressure view">
        <TabsTrigger value="scatter">Scatter</TabsTrigger>
        <TabsTrigger value="twin">Twin bars</TabsTrigger>
      </TabsList>
      <p className="text-muted-foreground text-xs">
        Spill and GC pressure both stem from tight executor memory, see{' '}
        <DocsLink anchor="#memory-model">how Spark&rsquo;s memory model works</DocsLink>.
      </p>

      <TabsContent value="scatter">
        <div className="mb-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <ImpactDot impactBand="critical" />
            CRITICAL
          </span>
          <span className="flex items-center gap-1">
            <ImpactDot impactBand="warning" />
            WARNING
          </span>
          <span className="flex items-center gap-1">
            <ImpactDot impactBand="info" />
            INFO
          </span>
        </div>
        <ChartFrame
          ariaLabel="Memory pressure scatter: spilled memory versus GC percent, one point per stage that spilled."
          height={HEIGHT}
          table={{
            caption: 'Memory spilled and GC percent by stage',
            columns: ['Stage', 'Memory spilled', 'GC %'],
            rows: sampled.map((p) => [`S${p.stageId}`, formatBytes(p.spillBytes), `${p.gcPct.toFixed(1)}%`]),
            align: ['left', 'right', 'right'],
          }}
        >
            <ScatterChart>
              <CartesianGrid stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
              <XAxis
                type="number"
                dataKey="spillBytes"
                name="Memory spilled"
                tickFormatter={(v: number) => formatBytes(v)}
                tick={{ fontSize: 10 }}
              />
              <YAxis type="number" dataKey="gcPct" name="GC %" tick={{ fontSize: 10 }} width={32} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={ScatterTooltipContent} />
              <Scatter data={sampled} name="Spill vs. GC">
                {sampled.map((p) => (
                  <Cell key={p.stageId} fill={impactColor(p)} />
                ))}
              </Scatter>
            </ScatterChart>
        </ChartFrame>
      </TabsContent>

      <TabsContent value="twin">
        <ChartFrame
          ariaLabel="Memory pressure by stage: spilled memory and GC percent across stages in submission order."
          height={HEIGHT}
          table={{
            caption: 'Spilled memory and GC percent by stage, submission order',
            columns: ['Stage', 'Spill (MB)', 'GC %'],
            rows: twinData.map((d) => [d.stage, d.spillMB.toFixed(1), `${d.gcPct.toFixed(1)}%`]),
            align: ['left', 'right', 'right'],
          }}
        >
            <ComposedChart data={twinData}>
              <CartesianGrid stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
              <XAxis dataKey="stage" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="left" tick={{ fontSize: 10 }} width={36} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} width={36} />
              <Tooltip />
              <Bar yAxisId="left" dataKey="spillMB" name="Spill (MB)" fill={CHART_COLORS.critical} />
              <Line yAxisId="right" dataKey="gcPct" name="GC %" stroke={CHART_COLORS.info} dot={false} />
            </ComposedChart>
        </ChartFrame>
      </TabsContent>
    </Tabs>
  );
}
