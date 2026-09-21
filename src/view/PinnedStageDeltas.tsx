import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { WidgetCard } from '@/view/WidgetCard';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration } from '@sparkforensics/core/format-utils.ts';

export interface StageMetrics {
  duration: number | null;
  memoryBytesSpilled: number | null;
  diskBytesSpilled: number | null;
  jvmGCTime: number | null;
  inputBytes: number | null;
  outputBytes: number | null;
  executorRunTime: number | null;
  taskCount: number | null;
  failedTasks: number | null;
}
export interface StageSummary {
  id: number;
  name: string;
  metrics: StageMetrics;
}

const countFmt = (v: number) => String(v);
// One row per field, with its unit formatter. Order = most-interpretable first.
const FIELDS: { key: keyof StageMetrics; label: string; fmt: (v: number) => string }[] = [
  { key: 'duration', label: 'Duration', fmt: formatDuration },
  { key: 'executorRunTime', label: 'Executor run-time', fmt: formatDuration },
  { key: 'jvmGCTime', label: 'GC time', fmt: formatDuration },
  { key: 'memoryBytesSpilled', label: 'Memory spill', fmt: formatBytes },
  { key: 'diskBytesSpilled', label: 'Disk spill', fmt: formatBytes },
  { key: 'inputBytes', label: 'Input read', fmt: formatBytes },
  { key: 'outputBytes', label: 'Output written', fmt: formatBytes },
  { key: 'taskCount', label: 'Task count', fmt: countFmt },
  { key: 'failedTasks', label: 'Failed tasks', fmt: countFmt },
];

function fmtAbs(v: number | null, fmt: (v: number) => string) {
  return v == null ? '—' : fmt(v);
}
// Signed delta with the field's own unit; more = worse (cost metrics), so a
// positive delta is a regression. Color mirrors the aggregate Metrics table.
function DeltaCell({ base, cand, fmt }: { base: number | null; cand: number | null; fmt: (v: number) => string }) {
  if (base == null || cand == null) return <TableCell className="text-muted-foreground">—</TableCell>;
  const d = cand - base;
  const text = d === 0 ? 'unchanged' : (d < 0 ? '-' : '+') + fmt(Math.abs(d));
  const color = d === 0 ? 'text-muted-foreground' : d < 0 ? 'text-clean' : 'text-critical';
  return <TableCell className={cn('font-medium', color)}>{text}</TableCell>;
}

function PairTable({ base, cand }: { base: StageSummary; cand: StageSummary }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="text-left">Metric</TableHead>
          <TableHead>Baseline</TableHead>
          <TableHead>Candidate</TableHead>
          <TableHead>Δ</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {FIELDS.map((f) => (
          <TableRow key={f.key} aria-label={f.label}>
            <TableHead scope="row" className="text-left">{f.label}</TableHead>
            <TableCell>{fmtAbs(base.metrics[f.key], f.fmt)}</TableCell>
            <TableCell>{fmtAbs(cand.metrics[f.key], f.fmt)}</TableCell>
            <DeltaCell base={base.metrics[f.key]} cand={cand.metrics[f.key]} fmt={f.fmt} />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

interface Pin { baseId: number; candId: number; }

export function PinnedStageDeltas({ baseStages, candStages }: { baseStages: StageSummary[]; candStages: StageSummary[] }) {
  const [baseId, setBaseId] = useState('');
  const [candId, setCandId] = useState('');
  const [pins, setPins] = useState<Pin[]>([]);

  // Automatic stage matching is deliberately not attempted (unreliable on real
  // AQE logs); pairs are user-chosen only. Nothing to pin with an empty side.
  if (baseStages.length === 0 || candStages.length === 0) return null;

  const findBase = (id: number) => baseStages.find((s) => s.id === id);
  const findCand = (id: number) => candStages.find((s) => s.id === id);
  const addPin = () => {
    if (baseId === '' || candId === '') return;
    setPins((p) => [...p, { baseId: Number(baseId), candId: Number(candId) }]);
  };
  const removePin = (i: number) => setPins((p) => p.filter((_, idx) => idx !== i));

  return (
    <WidgetCard title="Pinned per-stage deltas">
      <p className="mb-3 text-xs text-muted-foreground">
        Pick one stage from each run to compare directly. Pairs are chosen by you: no automatic matching.
      </p>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Baseline stage
          <select className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                  value={baseId} onChange={(e) => setBaseId(e.target.value)}>
            <option value="">Select…</option>
            {baseStages.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          Candidate stage
          <select className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground"
                  value={candId} onChange={(e) => setCandId(e.target.value)}>
            <option value="">Select…</option>
            {candStages.map((s) => <option key={s.id} value={String(s.id)}>{s.name}</option>)}
          </select>
        </label>
        <Button type="button" size="sm" disabled={baseId === '' || candId === ''} onClick={addPin}>Pin pair</Button>
      </div>

      <div className="flex flex-col gap-4">
        {pins.map((pin, i) => {
          const base = findBase(pin.baseId), cand = findCand(pin.candId);
          if (!base || !cand) return null;
          return (
            <div key={i} className="rounded border border-border p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{base.name} → {cand.name}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => removePin(i)}>Remove</Button>
              </div>
              <PairTable base={base} cand={cand} />
            </div>
          );
        })}
      </div>
    </WidgetCard>
  );
}
