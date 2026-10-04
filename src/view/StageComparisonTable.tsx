import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { WidgetCard } from '@/view/WidgetCard';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { PairDeltaMetric, ReplannedGroup, StageAlignment, StageDelta, StagePair } from '@sparkforensics/core/stage-alignment.ts';

export type StageSide = 'baseline' | 'candidate';

export interface StageComparisonInput {
  stagePairs: StagePair[];
  unmatched: StageAlignment['unmatched'];
  replanned: ReplannedGroup[];
  baseStages?: Array<{ id: number; name: string }>;
  candStages?: Array<{ id: number; name: string }>;
}

const INITIAL_ROWS = 25;
const MORE_ROWS = 50;

type Fmt = (v: number) => string;
interface Column { label: string; metrics: PairDeltaMetric[]; fmt: Fmt; neutral?: boolean }
// Spill and shuffle each sum their two metrics into one column; input and output are workload
// volume, so a change in them is not coloured as a regression.
const COLUMNS: Column[] = [
  { label: 'Run time', metrics: ['executorRunTime'], fmt: formatDuration },
  { label: 'CPU time', metrics: ['executorCpuTime'], fmt: formatDuration },
  { label: 'Spill', metrics: ['memoryBytesSpilled', 'diskBytesSpilled'], fmt: formatBytes },
  { label: 'Input', metrics: ['inputBytes'], fmt: formatBytes, neutral: true },
  { label: 'Output', metrics: ['outputBytes'], fmt: formatBytes, neutral: true },
  { label: 'Shuffle', metrics: ['shuffleReadBytes', 'shuffleWriteBytes'], fmt: formatBytes },
];

const QUALITY_HELP: Record<StagePair['quality'], string> = {
  exact: 'Same plan and details in both runs.',
  structural: 'Same plan shape; details such as literals or paths differ.',
  aligned: 'Different plan shape, paired by similarity or position. The two stages may not be the same work.',
};

/** Sum of a column's metrics for one pair; null when none of its metrics has both sides. */
function columnDelta(deltas: Record<PairDeltaMetric, StageDelta>, metrics: PairDeltaMetric[]): number | null {
  let total: number | null = null;
  for (const m of metrics) {
    const d = deltas[m].delta;
    if (d != null) total = (total ?? 0) + d;
  }
  return total;
}

function DeltaCell({ value, column }: { value: number | null; column: Column }) {
  if (value == null) return <TableCell className="text-muted-foreground">—</TableCell>;
  const text = value === 0 ? 'unchanged' : (value < 0 ? '-' : '+') + column.fmt(Math.abs(value));
  const color = value === 0 || column.neutral ? 'text-muted-foreground' : value < 0 ? 'text-clean' : 'text-critical';
  return <TableCell className={cn('font-medium', color)}>{text}</TableCell>;
}

const linkClass = 'cursor-pointer rounded text-xs underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none';

/** One open-in-run link per stage id. A pair or group can hold several stages per side. */
function OpenLinks({ side, ids, onOpen }: { side: StageSide; ids: number[]; onOpen: (side: StageSide, stageId: number) => void }) {
  if (ids.length === 0) return <span className="text-xs text-muted-foreground">none</span>;
  return (
    <>
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className={cn(linkClass, 'mr-2')}
          aria-label={`Open stage ${id} in the ${side} run`}
          onClick={() => onOpen(side, id)}
        >
          {side === 'baseline' ? 'Baseline' : 'Candidate'} stage {id}
        </button>
      ))}
    </>
  );
}

function SideTotals({ label, deltas }: { label: string; deltas: ReplannedGroup['deltas'] }) {
  const t = deltas.executorRunTime;
  return <span>{label}: {t.baseline == null ? '—' : formatDuration(t.baseline)} → {t.candidate == null ? '—' : formatDuration(t.candidate)}</span>;
}

/** The paired stages of a comparison with each metric's change, biggest run-time change first.
 * Reads the aligner's result as given; nothing here pairs stages. */
export function StageComparisonTable({ model, onOpenStage }: { model: StageComparisonInput; onOpenStage: (side: StageSide, stageId: number) => void }) {
  const [shown, setShown] = useState(INITIAL_ROWS);
  const nameOf = (stages: StageComparisonInput['baseStages'], id: number) => stages?.find((s) => s.id === id)?.name;
  const pairs = [...model.stagePairs].sort((a, b) =>
    Math.abs(b.deltas.executorRunTime.delta ?? 0) - Math.abs(a.deltas.executorRunTime.delta ?? 0)
    || a.pairId.localeCompare(b.pairId));
  const unmatched = model.unmatched;
  const hasUnmatched = unmatched.baseStageIds.length + unmatched.candStageIds.length > 0;
  if (pairs.length === 0 && model.replanned.length === 0 && !hasUnmatched) return null;

  return (
    <WidgetCard title="Stages compared">
      {pairs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No stages are paired between the two runs.</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            Change from baseline to candidate, largest run-time change first. Under each stage, quality says how the pair was matched and score is how alike they are, from 0 to 1.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Stage</TableHead>
                {COLUMNS.map((c) => <TableHead key={c.label}>{c.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.slice(0, shown).map((p) => (
                <TableRow key={p.pairId} data-testid="stage-pair-row" data-quality={p.quality}>
                  <TableHead scope="row" className="text-left">
                    <div className="max-w-[14rem] truncate" title={nameOf(model.baseStages, p.baseStageIds[0]) ?? undefined}>
                      {nameOf(model.baseStages, p.baseStageIds[0]) ?? `Stage ${p.baseStageIds[0]}`}
                    </div>
                    <div className="mt-0.5 text-xs font-normal text-muted-foreground" title={QUALITY_HELP[p.quality]}>
                      {p.quality} · {p.score.toFixed(2)}
                    </div>
                    <div className="mt-1 flex flex-wrap">
                      <OpenLinks side="baseline" ids={p.baseStageIds} onOpen={onOpenStage} />
                      <OpenLinks side="candidate" ids={p.candStageIds} onOpen={onOpenStage} />
                    </div>
                  </TableHead>
                  {COLUMNS.map((c) => <DeltaCell key={c.label} value={columnDelta(p.deltas, c.metrics)} column={c} />)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {pairs.length > shown ? (
            <Button variant="ghost" size="sm" className="mt-2" onClick={() => setShown((n) => n + MORE_ROWS)}>
              Show {Math.min(MORE_ROWS, pairs.length - shown)} more of {pairs.length - shown} remaining
            </Button>
          ) : null}
        </>
      )}

      {model.replanned.length > 0 ? (
        <div className="mt-4" data-testid="replanned-stages">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Re-planned work</h4>
          <p className="mb-2 text-xs text-muted-foreground">
            These queries ran a different number of stages, so the leftover stages are compared as a group rather than one by one.
          </p>
          <ul className="flex flex-col gap-2">
            {model.replanned.map((g) => (
              <li key={`${g.baseExecutionId}-${g.candExecutionId}`} className="border-b border-border pb-2 text-sm last:border-0">
                <div className="flex flex-wrap gap-x-4 text-xs text-muted-foreground">
                  <span>Query {g.baseExecutionId} → {g.candExecutionId}</span>
                  <SideTotals label="Run time" deltas={g.deltas} />
                </div>
                <div className="mt-1 flex flex-wrap">
                  <OpenLinks side="baseline" ids={g.baseStageIds} onOpen={onOpenStage} />
                  <OpenLinks side="candidate" ids={g.candStageIds} onOpen={onOpenStage} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasUnmatched ? (
        <div className="mt-4" data-testid="unmatched-stages">
          <h4 className="mb-1 text-xs font-semibold text-muted-foreground">Unmatched stages</h4>
          <div className="flex flex-wrap">
            <OpenLinks side="baseline" ids={unmatched.baseStageIds} onOpen={onOpenStage} />
            <OpenLinks side="candidate" ids={unmatched.candStageIds} onOpen={onOpenStage} />
          </div>
        </div>
      ) : null}
    </WidgetCard>
  );
}
