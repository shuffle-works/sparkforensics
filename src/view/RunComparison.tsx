import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { PinnedStageDeltas, type StageSummary } from '@/view/PinnedStageDeltas';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';
import { cn } from '@/lib/utils';
import { formatBytes, formatDuration, typeTag } from '@sparkforensics/core/format-utils.ts';
import { NEUTRAL_METRIC_KEYS } from '@sparkforensics/core/run-comparison.ts';
import type { ImpactBand } from '@sparkforensics/core/types.ts';

interface MetricDelta {
  key: string; label: string;
  baseline: number | null; candidate: number | null; delta: number | null;
  direction: 'improvement' | 'regression' | 'unchanged' | 'neutral' | 'unavailable';
  unavailableReason?: string;
}
interface CategoryDelta {
  rule: string; impactBand: string;
  baseCount: number; candCount: number; delta: number;
  stages: string[]; // stage names from the side with more (candidate for introduced, baseline for resolved)
}
interface ComparisonModel {
  baselineLabel: string; candidateLabel: string;
  confidence: 'ok' | 'low';
  reason: string | null; matchedCoverage: number;
  metrics: MetricDelta[];
  findings: { introduced: CategoryDelta[]; resolved: CategoryDelta[] };
  stageSkew: Array<{ identity: string; baseId: number; candId: number; baseline: number | null; candidate: number | null; delta: number | null }>;
  baseStages?: StageSummary[];
  candStages?: StageSummary[];
}

// Per-unit formatting: raw ms/bytes rendered through a bare NumberFormat read as
// "213.733" (locale thousands separator, no unit). Format each metric by its own
// unit and label it. Absolute values are ≥ 0; deltas carry a sign.
const ratioFmt = (v: number) => `${v.toFixed(2)}×`;
const pctFmt = (v: number) => `${(v * 100).toFixed(1)}%`;
const ABS_FMT: Record<string, (v: number) => string> = {
  wallClock: formatDuration,
  shuffleSpill: formatBytes,
  taskSkew: ratioFmt,
  failedTaskRate: pctFmt,
  diskSpill: formatBytes,
  gcTime: formatDuration,
  inputBytes: formatBytes,
  outputBytes: formatBytes,
  executorRunTime: formatDuration,
  // taskCount, executorsAdded → default Intl.NumberFormat (plain counts)
};
const absFmtFor = (key: string) => ABS_FMT[key] ?? ((v: number) => Intl.NumberFormat().format(v));

// Δ color by direction only: MetricDelta carries direction + a signed delta but
// no per-metric impact band or magnitude threshold, so there is no data for a
// critical-vs-warning split. Regression → critical color, improvement → clean.
const DELTA_CLASS: Record<MetricDelta['direction'], string> = {
  regression: 'text-critical',
  improvement: 'text-clean',
  unchanged: 'text-muted-foreground',
  neutral: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
};

// Belt-and-suspenders alongside src/run-comparison.ts's own NEUTRAL_METRIC_KEYS
// check inside direction(): forces neutral coloring for these volume/count
// keys even if a `direction` value ever arrives mismatched (an older cached
// response, a hand-built fixture), since less/more input/output data or
// tasks/executors is never inherently better or worse.
function MetricRow({ m }: { m: MetricDelta }) {
  if (m.direction === 'unavailable') {
    return (
      <TableRow aria-label={m.label} data-direction="unavailable">
        <TableHead scope="row" className="text-left">{m.label}</TableHead>
        <TableCell colSpan={3} className="text-muted-foreground">Unavailable: {m.unavailableReason}</TableCell>
      </TableRow>
    );
  }
  const abs = absFmtFor(m.key);
  const fmtAbs = (v: number | null) => (v == null ? '—' : abs(v));
  // No arrow prefix: sign + magnitude only; DELTA_CLASS below already carries
  // the improvement/regression signal via color.
  const fmtDelta = (v: number | null) =>
    v == null ? '—' : v === 0 ? 'unchanged' : (v < 0 ? '-' : '+') + abs(Math.abs(v));
  const deltaClass = NEUTRAL_METRIC_KEYS.has(m.key) ? 'text-muted-foreground' : DELTA_CLASS[m.direction];
  return (
    <TableRow aria-label={m.label} data-direction={m.direction}>
      <TableHead scope="row" className="text-left">{m.label}</TableHead>
      <TableCell>{fmtAbs(m.baseline)}</TableCell>
      <TableCell>{fmtAbs(m.candidate)}</TableCell>
      <TableCell className={cn('font-medium', deltaClass)}>{fmtDelta(m.delta)}</TableCell>
    </TableRow>
  );
}

// CategoryDelta.impactBand is a plain string ('unknown' is possible); TagBadge
// only accepts the ImpactBand union. Map anything outside it to a muted default.
const IMPACT_BANDS: readonly ImpactBand[] = ['critical', 'warning', 'info'];
const toImpactBand = (s: string): ImpactBand => (IMPACT_BANDS.includes(s as ImpactBand) ? (s as ImpactBand) : 'info');

function StageChips({ stages }: { stages: string[] }) {
  if (stages.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {stages.map((name) => (
        <span key={name} className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{name}</span>
      ))}
    </div>
  );
}

function FindingRows({ items }: { items: CategoryDelta[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((f) => (
        <li key={`${f.rule}§${f.impactBand}`} className="flex flex-col gap-1 border-b border-border pb-2 last:border-0 last:pb-0">
          <div className="flex items-center gap-2">
            <TagBadge
              type={f.rule}
              impactBand={toImpactBand(f.impactBand)}
              className={typeTag(f.rule) === 'PLAN' ? PLAN_TAG_CLASS : undefined}
            />
            <span className="text-sm text-muted-foreground">{f.baseCount} → {f.candCount}</span>
          </div>
          <StageChips stages={f.stages} />
        </li>
      ))}
    </ul>
  );
}

// Names differing is a soft signal, not a block: warn, let the user dismiss,
// and still show every (name-independent) delta below.
function LowConfidenceBanner({ reason }: { reason: string }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <div role="alert" className="mb-4 flex items-start justify-between gap-3 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
      <span>{reason}</span>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss warning"
        className="shrink-0 cursor-pointer rounded px-1 text-muted-foreground hover:text-foreground"
      >
        Dismiss
      </button>
    </div>
  );
}

export function RunComparison({
  model, onClose, onDrillIn,
}: {
  model: ComparisonModel;
  onClose: () => void;
  onDrillIn?: (which: 'baseline' | 'candidate') => void;
}) {
  const coveragePct = Math.round(model.matchedCoverage * 100);
  // Full-page route (not a dialog), so wire Escape to close as a courtesy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const header = (
    <header className="mb-4 flex items-center justify-between gap-3">
      <div>
        <h1 className="font-heading text-lg font-semibold">Run comparison</h1>
        <p className="text-sm text-muted-foreground">
          Baseline <strong>{model.baselineLabel}</strong> vs candidate <strong>{model.candidateLabel}</strong>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onDrillIn ? (
          <>
            <Button variant="outline" size="sm" onClick={() => onDrillIn('baseline')}>View run A dashboard</Button>
            <Button variant="outline" size="sm" onClick={() => onDrillIn('candidate')}>View run B dashboard</Button>
          </>
        ) : null}
        <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
      </div>
    </header>
  );

  return (
    <div
      // Shares Dashboard's marker: the host site's chrome-toggle script
      // (shuffle-works-site-build) hides the shared nav/footer while this
      // testid is present. This is a separate full-page route that
      // replaces Dashboard's own "dashboard" node (App.tsx renders one or
      // the other, never both), so without this it would drop the only
      // signal that script has and let the chrome pop back in.
      data-testid="dashboard"
      className="mx-auto flex max-w-4xl flex-col gap-6 p-6"
    >
      {header}
      {/* display:contents keeps these as direct flex/gap-6 children of the
          wrapper above while still giving the post-header content its own
          landmark (a11y: "region"; all content must be within a landmark,
          and `header` above already covers the banner). */}
      <main className="contents">
        {/* WidgetCard always renders its title as an <h3> (one level below a
            board's <h2> section header, see WidgetCard.tsx); this page has no
            visible section header of its own, so a sr-only <h2> keeps the
            h1 -> h2 -> h3 order intact for screen readers. */}
        <h2 className="sr-only">Comparison results</h2>
        {model.confidence === 'low' && model.reason ? <LowConfidenceBanner reason={model.reason} /> : null}

        <WidgetCard title="Metrics">
          <p className="mb-3 text-xs text-muted-foreground">
            Metrics and finding categories cover the whole run. Per-stage skew below covers only the {coveragePct}% of stages that matched by unique identity.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-left">Metric</TableHead>
                <TableHead>Baseline ({model.baselineLabel})</TableHead>
                <TableHead>Candidate ({model.candidateLabel})</TableHead>
                <TableHead>Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>{model.metrics.map((m) => <MetricRow key={m.key} m={m} />)}</TableBody>
          </Table>
        </WidgetCard>

        {model.findings.introduced.length > 0 || model.findings.resolved.length > 0 ? (
          <WidgetCard title="Findings by category">
            {model.findings.introduced.length > 0 ? (
              <div className="mb-4">
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">More in candidate ({model.candidateLabel})</h3>
                <FindingRows items={model.findings.introduced} />
              </div>
            ) : null}
            {model.findings.resolved.length > 0 ? (
              <div>
                <h3 className="mb-2 text-xs font-semibold text-muted-foreground">Fewer in candidate ({model.candidateLabel})</h3>
                <FindingRows items={model.findings.resolved} />
              </div>
            ) : null}
          </WidgetCard>
        ) : null}

        {model.stageSkew.length > 0 ? (
          <WidgetCard title="Per-stage task skew (matched stages only)">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-left">Stage</TableHead>
                  <TableHead>Baseline</TableHead>
                  <TableHead>Candidate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {[...model.stageSkew]
                  .sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0))
                  .map((s) => (
                    <TableRow key={`${s.baseId}-${s.candId}`}>
                      <TableHead scope="row" className="text-left">{s.identity.split('§')[0]}</TableHead>
                      <TableCell>{s.baseline == null ? '—' : ratioFmt(s.baseline)}</TableCell>
                      <TableCell>{s.candidate == null ? '—' : ratioFmt(s.candidate)}</TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          </WidgetCard>
        ) : null}

        <PinnedStageDeltas baseStages={model.baseStages ?? []} candStages={model.candStages ?? []} />
      </main>
    </div>
  );
}
