import { Table, TableBody, TableCell, TableHead, TableRow } from '@/components/ui/table';
import { WidgetCard } from '@/view/WidgetCard';
import { formatBytes, formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { Comparability, VolumeFigure } from '@sparkforensics/core/comparability.ts';

const COUNT = Intl.NumberFormat();
const MAX_LISTED_CONF_KEYS = 8;

const executors = (v: number | null) => (v == null ? '—' : v.toFixed(1));
const times = (v: number | null) => (v == null ? '—' : `×${v.toFixed(2)}`);
const share = (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);

function relative(figure: VolumeFigure): string {
  const diff = figure.relativeDifference;
  if (diff == null) return figure.baseline == null || figure.candidate == null ? 'Unavailable' : 'Baseline is 0';
  if (diff === 0) return 'Equal';
  return `${diff > 0 ? '+' : '-'}${(Math.abs(diff) * 100).toFixed(1)}%`;
}

function Row({ label, baseline, candidate, note }: { label: string; baseline: string; candidate: string; note: string }) {
  return (
    <TableRow aria-label={label}>
      <TableHead scope="row" className="text-left">{label}</TableHead>
      <TableCell>{baseline}</TableCell>
      <TableCell>{candidate}</TableCell>
      <TableCell className="text-muted-foreground">{note}</TableCell>
    </TableRow>
  );
}

function confNote({ conf }: Comparability): string {
  if (conf.equal == null) return 'A log records no Spark properties';
  if (conf.equal) return conf.ignoredKeys.length > 0 ? `Same (${conf.ignoredKeys.length} ignored)` : 'Same';
  return `${conf.differences.length} differ`;
}

function planNote({ plan }: Comparability): string {
  if (plan.equal) return 'Every stage pairs';
  return `${plan.unmatched.baseline} baseline and ${plan.unmatched.candidate} candidate stages unmatched, ${plan.replanned} re-planned`;
}

/** What the two runs share and where they differ, so a time difference is not read as a
 * regression when the runs only had different capacity. The metrics table below carries the
 * figures behind each line. */
export function ComparabilityCard({ comparability, baselineLabel, candidateLabel }: {
  comparability: Comparability; baselineLabel: string; candidateLabel: string;
}) {
  const { conf, volume, capacity, wallClockBridge: bridge, overlapMs } = comparability;
  const listed = conf.differences.slice(0, MAX_LISTED_CONF_KEYS);
  return (
    <div data-testid="comparability-card">
    <WidgetCard title="What differs between the runs">
      <Table className="trace-table">
        <TableBody>
          <TableRow>
            <TableHead className="text-left">Figure</TableHead>
            <TableHead title={baselineLabel}>Baseline</TableHead>
            <TableHead title={candidateLabel}>Candidate</TableHead>
            <TableHead>Comparison</TableHead>
          </TableRow>
          <Row label="Spark configuration" baseline="" candidate="" note={confNote(comparability)} />
          <Row label="Plan" baseline="" candidate="" note={planNote(comparability)} />
          <Row label="Input read" baseline={volume.inputBytes.baseline == null ? '—' : formatBytes(volume.inputBytes.baseline)}
            candidate={volume.inputBytes.candidate == null ? '—' : formatBytes(volume.inputBytes.candidate)} note={relative(volume.inputBytes)} />
          <Row label="Output rows" baseline={volume.outputRows.baseline == null ? '—' : COUNT.format(volume.outputRows.baseline)}
            candidate={volume.outputRows.candidate == null ? '—' : COUNT.format(volume.outputRows.candidate)} note={relative(volume.outputRows)} />
          <Row label="Output written" baseline={volume.outputBytes.baseline == null ? '—' : formatBytes(volume.outputBytes.baseline)}
            candidate={volume.outputBytes.candidate == null ? '—' : formatBytes(volume.outputBytes.candidate)} note={relative(volume.outputBytes)} />
          <Row label="Executors, mean" baseline={executors(capacity.baseline.meanExecutors)} candidate={executors(capacity.candidate.meanExecutors)} note={times(bridge.meanExecutors.ratio)} />
          <Row label="Executors, peak" baseline={executors(capacity.baseline.peakExecutors)} candidate={executors(capacity.candidate.peakExecutors)}
            note={times(capacity.baseline.peakExecutors && capacity.candidate.peakExecutors ? capacity.candidate.peakExecutors / capacity.baseline.peakExecutors : null)} />
          <Row label="Task time, share of allocated core time" baseline={share(bridge.taskShareOfAllocation.baseline)} candidate={share(bridge.taskShareOfAllocation.candidate)} note={times(bridge.taskShareOfAllocation.ratio)} />
        </TableBody>
      </Table>
      {listed.length > 0 ? (
        <ul className="mt-3 flex flex-col gap-1 text-xs" aria-label="Configuration differences">
          {listed.map((d) => (
            <li key={d.key} className="font-mono">
              <span className="text-foreground">{d.key}</span>
              <span className="text-muted-foreground">: {d.baseline ?? 'not set'} → {d.candidate ?? 'not set'}</span>
            </li>
          ))}
          {conf.differences.length > listed.length ? (
            <li className="text-muted-foreground">and {conf.differences.length - listed.length} more</li>
          ) : null}
        </ul>
      ) : null}
      <p className="mt-3 text-xs text-muted-foreground">
        {overlapMs == null ? 'The run windows are not both known.' : overlapMs === 0 ? 'The runs did not overlap in time.' : `The runs overlapped for ${formatDuration(overlapMs)}.`}
        {bridge.explainedWallClock != null && bridge.wallClock.ratio != null
          ? ` Wall clock ${times(bridge.wallClock.ratio)} follows from task time ${times(bridge.taskTime.ratio)} over mean executors ${times(bridge.meanExecutors.ratio)} times the task-time share ${times(bridge.taskShareOfAllocation.ratio)}, which is ${times(bridge.explainedWallClock)}.`
          : ''}
      </p>
    </WidgetCard>
    </div>
  );
}
