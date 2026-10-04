import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { WidgetCard } from '@/view/WidgetCard';
import { PairTable, type StageSummary } from '@/view/PinnedStageDeltas';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { PairDeltaMetric, ReplannedGroup, StageAlignment, StageDelta, StagePair } from '@sparkforensics/core/stage-alignment.ts';

export type StageSide = 'baseline' | 'candidate';

export interface StageComparisonInput {
  stagePairs: StagePair[];
  unmatched: StageAlignment['unmatched'];
  replanned: ReplannedGroup[];
  baseStages?: StageSummary[];
  candStages?: StageSummary[];
}

/** The stages a row, replanned group or unmatched list stands for, opened side by side. */
interface Selection { title: string; note: string | null; baseStageIds: number[]; candStageIds: number[] }

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

const linkClass = 'cursor-pointer rounded text-left text-xs underline-offset-2 hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none';

function SideTotals({ label, deltas }: { label: string; deltas: ReplannedGroup['deltas'] }) {
  const t = deltas.executorRunTime;
  return <span>{label}: {t.baseline == null ? '—' : formatDuration(t.baseline)} → {t.candidate == null ? '—' : formatDuration(t.candidate)}</span>;
}

/** The paired stages of a comparison with each metric's change, biggest run-time change first.
 * Reads the aligner's result as given; nothing here pairs stages. */
export function StageComparisonTable({ model, baselineLabel, candidateLabel, onOpenStage }: {
  model: StageComparisonInput;
  baselineLabel: string;
  candidateLabel: string;
  /** Opens one stage in that run's own dashboard. */
  onOpenStage: (side: StageSide, stageId: number) => void;
}) {
  const [shown, setShown] = useState(INITIAL_ROWS);
  const [selection, setSelection] = useState<Selection | null>(null);
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
            Change from baseline to candidate, largest run-time change first. Under each stage, quality says how the pair was matched and score is how alike they are, from 0 to 1. Select a stage to see both runs side by side.
          </p>
          <Table className="trace-table">
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Stage</TableHead>
                {COLUMNS.map((c) => <TableHead key={c.label}>{c.label}</TableHead>)}
              </TableRow>
            </TableHeader>
            <TableBody>
              {pairs.slice(0, shown).map((p) => {
                const name = nameOf(model.baseStages, p.baseStageIds[0]) ?? `Stage ${p.baseStageIds[0]}`;
                return (
                  <TableRow key={p.pairId} data-testid="stage-pair-row" data-quality={p.quality}>
                    <TableHead scope="row" className="text-left">
                      <button
                        type="button"
                        className={cn(linkClass, 'block max-w-[22rem] truncate text-sm font-medium')}
                        title={name}
                        aria-label={`Compare ${name} in both runs`}
                        onClick={() => setSelection({
                          title: name, note: `${p.quality} match, score ${p.score.toFixed(2)}. ${QUALITY_HELP[p.quality]}`,
                          baseStageIds: p.baseStageIds, candStageIds: p.candStageIds,
                        })}
                      >
                        {name}
                      </button>
                      <div className="stage-pair-meta mt-0.5" title={QUALITY_HELP[p.quality]}>
                        {p.quality} · {p.score.toFixed(2)}
                      </div>
                    </TableHead>
                    {COLUMNS.map((c) => <DeltaCell key={c.label} value={columnDelta(p.deltas, c.metrics)} column={c} />)}
                  </TableRow>
                );
              })}
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
          <h4 className="trace-eyebrow mb-1">Re-planned work</h4>
          <p className="mb-2 text-xs text-muted-foreground">
            These queries ran a different number of stages, so the leftover stages are compared as a group rather than one by one.
          </p>
          <ul className="flex flex-col gap-2">
            {model.replanned.map((g) => (
              <li key={`${g.baseExecutionId}-${g.candExecutionId}`} className="border-b border-border pb-2 text-sm last:border-0">
                <div className="flex flex-wrap gap-x-4 font-mono text-[11px] text-muted-foreground">
                  <span>Query {g.baseExecutionId} → {g.candExecutionId}</span>
                  <SideTotals label="Run time" deltas={g.deltas} />
                </div>
                <button
                  type="button"
                  className={cn(linkClass, 'mt-1')}
                  onClick={() => setSelection({
                    title: `Re-planned query ${g.baseExecutionId} → ${g.candExecutionId}`,
                    note: 'The two runs ran a different number of stages here, so these leftover stages are not paired one to one.',
                    baseStageIds: g.baseStageIds, candStageIds: g.candStageIds,
                  })}
                >
                  Baseline {stageList(g.baseStageIds)} · Candidate {stageList(g.candStageIds)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {hasUnmatched ? (
        <div className="mt-4" data-testid="unmatched-stages">
          <h4 className="trace-eyebrow mb-1">Unmatched stages</h4>
          <button
            type="button"
            className={linkClass}
            onClick={() => setSelection({
              title: 'Unmatched stages', note: 'These stages paired with nothing in the other run.',
              baseStageIds: unmatched.baseStageIds, candStageIds: unmatched.candStageIds,
            })}
          >
            Baseline {stageList(unmatched.baseStageIds)} · Candidate {stageList(unmatched.candStageIds)}
          </button>
        </div>
      ) : null}

      <StagePairDialog
        selection={selection}
        baseStages={model.baseStages ?? []}
        candStages={model.candStages ?? []}
        baselineLabel={baselineLabel}
        candidateLabel={candidateLabel}
        onClose={() => setSelection(null)}
        onOpenStage={onOpenStage}
      />
    </WidgetCard>
  );
}

const stageList = (ids: number[]) => (ids.length === 0 ? 'none' : ids.join(', '));

const MISSING: StageSummary = {
  id: -1, name: '—',
  metrics: { duration: null, memoryBytesSpilled: null, diskBytesSpilled: null, jvmGCTime: null, inputBytes: null, outputBytes: null, executorRunTime: null, taskCount: null, failedTasks: null },
};

/** Both runs' figures for the selected stages in one table, without leaving the comparison. A group
 * with several stages per side lines them up in id order; a side with fewer shows dashes. */
function StagePairDialog({ selection, baseStages, candStages, baselineLabel, candidateLabel, onClose, onOpenStage }: {
  selection: Selection | null;
  baseStages: StageSummary[];
  candStages: StageSummary[];
  baselineLabel: string;
  candidateLabel: string;
  onClose: () => void;
  onOpenStage: (side: StageSide, stageId: number) => void;
}) {
  const find = (stages: StageSummary[], id: number | undefined) => stages.find((s) => s.id === id) ?? MISSING;
  const rows = selection
    ? Array.from({ length: Math.max(selection.baseStageIds.length, selection.candStageIds.length) }, (_, i) => ({
        baseId: selection.baseStageIds[i], candId: selection.candStageIds[i],
      }))
    : [];
  return (
    <Dialog open={selection !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-5xl" data-testid="stage-pair-dialog">
        {selection ? (
          <>
            <DialogHeader>
              <DialogTitle className="[overflow-wrap:anywhere]">{selection.title}</DialogTitle>
              {selection.note ? <DialogDescription>{selection.note}</DialogDescription> : null}
            </DialogHeader>
            <div className="flex flex-col gap-4">
              {rows.map(({ baseId, candId }, i) => {
                const base = find(baseStages, baseId), cand = find(candStages, candId);
                return (
                  <section key={i} aria-label={`Stage ${baseId ?? 'none'} and stage ${candId ?? 'none'}`} className="comparison-subpanel p-3">
                    <div className="mb-2 grid gap-2 text-xs sm:grid-cols-2">
                      <div title={baselineLabel}>
                        <div className="font-semibold">Baseline{baseId === undefined ? '' : ` · stage ${baseId}`}</div>
                        <div className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{base.name}</div>
                      </div>
                      <div title={candidateLabel}>
                        <div className="font-semibold">Candidate{candId === undefined ? '' : ` · stage ${candId}`}</div>
                        <div className="font-mono text-muted-foreground [overflow-wrap:anywhere]">{cand.name}</div>
                      </div>
                    </div>
                    <PairTable base={base} cand={cand} />
                    <div className="mt-2 flex flex-wrap gap-2">
                      {baseId !== undefined ? (
                        <Button variant="outline" size="sm" onClick={() => onOpenStage('baseline', baseId)}>Open stage {baseId} in the baseline dashboard</Button>
                      ) : null}
                      {candId !== undefined ? (
                        <Button variant="outline" size="sm" onClick={() => onOpenStage('candidate', candId)}>Open stage {candId} in the candidate dashboard</Button>
                      ) : null}
                    </div>
                  </section>
                );
              })}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
