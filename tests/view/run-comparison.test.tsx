// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RunComparison } from '@/view/RunComparison';
import { compareRuns } from '@sparkforensics/core/run-comparison.ts';

const mk = (stages: any, app: any) => ({
  snapshot: {
    app, stages: new Map<number, any>(stages), sql: new Map(), catalog: [],
    executors: { added: [], removed: [] }, jobs: new Map(),
    runAggregates: null, evidenceAvailability: null, taskData: new Map(),
  },
});

test('labels baseline and candidate and shows the coverage caveat in a card body', () => {
  const model = compareRuns(
    { label: 'base.log', ...mk([[1, { name: 'Exchange 1' }]], { name: 'A' }) },
    { label: 'cand.log', ...mk([[9, { name: 'Exchange 2' }]], { name: 'A' }) },
  );
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByText('base.log')).toBeInTheDocument();
  expect(screen.getByText('cand.log')).toBeInTheDocument();
  expect(screen.getByText(/% of stages that matched by unique identity/i)).toBeInTheDocument();
});

test('renders findings as tag badges with base→cand counts and stage chips', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [],
    findings: {
      introduced: [{ rule: 'spill', type: 'spill', impactBand: 'warning', baseCount: 0, candCount: 2, delta: 2, stages: ['Exchange 10', 'Sort 11'] }],
      resolved: [{ rule: 'gc', type: 'gc', impactBand: 'unknown', baseCount: 1, candCount: 0, delta: -1, stages: [] }],
    },
    stageSkew: [],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByText('SPILL')).toBeInTheDocument(); // TagBadge via typeTag
  expect(screen.getByText('0 → 2')).toBeInTheDocument();
  expect(screen.getByText('Exchange 10')).toBeInTheDocument();
  expect(screen.getByText('Sort 11')).toBeInTheDocument();
  expect(screen.getByText(/More in candidate/i)).toBeInTheDocument();
});

test('renders a PLAN-tagged finding with the dedicated plan-aggregate color', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [],
    findings: {
      introduced: [{ rule: 'duplicatePlanSubtree', type: 'duplicatePlanSubtree', impactBand: 'warning', baseCount: 0, candCount: 1, delta: 1, stages: [] }],
      resolved: [],
    },
    stageSkew: [],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  const badge = screen.getByText('PLAN');
  expect(badge).toHaveClass('text-plan-aggregate');
  expect(badge).not.toHaveClass('text-warning');
});

test('two introduced findings sharing a rule at different severities render without a duplicate-key warning', () => {
  // findingsDelta groups by `${rule}§${impactBand}` (see run-comparison.js), so
  // one rule regressing at two severities in the same direction is valid
  // output: both rows land in `introduced` together.
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [],
    findings: {
      introduced: [
        { rule: 'taskStageSkew', type: 'stageShape', impactBand: 'warning', baseCount: 0, candCount: 1, delta: 1, stages: ['Stage A'] },
        { rule: 'taskStageSkew', type: 'stageShape', impactBand: 'critical', baseCount: 0, candCount: 1, delta: 1, stages: ['Stage B'] },
      ],
      resolved: [],
    },
    stageSkew: [],
  };
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  const duplicateKeyWarning = errorSpy.mock.calls.some((args) => String(args[0]).includes('same key'));
  expect(duplicateKeyWarning).toBe(false);
  expect(screen.getAllByText('SHAPE')).toHaveLength(2);
  errorSpy.mockRestore();
});

test('different names render a dismissible low-confidence banner but still show metrics', async () => {
  const user = userEvent.setup();
  const stage = (over: any) => ({
    name: 'Exchange 1', sqlExecutionId: null, submittedAt: 0, completedAt: 1000,
    taskDurationMax: 100, taskCount: 10, failedTasks: 0, memoryBytesSpilled: 0, ...over,
  });
  const model = compareRuns(
    { label: 'base.log', ...mk([[1, stage({})]], { name: 'A' }) },
    { label: 'cand.log', ...mk([[1, stage({})]], { name: 'B' }) },
  );
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByRole('alert')).toHaveTextContent(/run names differ/i);
  // Metrics still render; a name mismatch no longer hides the comparison.
  expect(screen.getByRole('row', { name: /wall-clock/i })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('metrics render with their unit and signed deltas in a Table', () => {
  const stage = (over: any) => ({
    name: 'Exchange 1', sqlExecutionId: null, submittedAt: 0, completedAt: 1000,
    taskDurationMax: 100, taskCount: 10, failedTasks: 0, memoryBytesSpilled: 0, ...over,
  });
  const model = compareRuns(
    { label: 'base.log', ...mk([[1, stage({ memoryBytesSpilled: 2_000_000, failedTasks: 2 })]], { name: 'A' }) },
    { label: 'cand.log', ...mk([[9, stage({ memoryBytesSpilled: 1_000_000, failedTasks: 1 })]], { name: 'A' }) },
  );
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByText('2 MB')).toBeInTheDocument();
  expect(screen.getByText('-1 MB')).toBeInTheDocument();
  expect(screen.getByText('20.0%')).toBeInTheDocument();
  expect(screen.getByText('-10.0%')).toBeInTheDocument();
});

test('volume/count metrics render Δ in neutral color, unlike cost metrics', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1,
    metrics: [
      // "more output" isn't clearly worse, so direction shouldn't drive color here.
      { key: 'outputBytes', label: 'Output bytes', baseline: 1_000_000, candidate: 2_000_000, delta: 1_000_000, direction: 'improvement' },
      { key: 'diskSpill', label: 'Disk spill', baseline: 2_000_000, candidate: 1_000_000, delta: -1_000_000, direction: 'improvement' },
    ],
    findings: { introduced: [], resolved: [] }, stageSkew: [],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  const outputDelta = within(screen.getByRole('row', { name: /output bytes/i })).getAllByRole('cell').at(-1)!;
  expect(outputDelta).toHaveClass('text-muted-foreground');
  expect(outputDelta).not.toHaveClass('text-clean');

  const diskDelta = within(screen.getByRole('row', { name: /disk spill/i })).getAllByRole('cell').at(-1)!;
  expect(diskDelta).toHaveClass('text-clean');
});

test('per-stage skew table formats ratios like the Metrics table (x.xx×)', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [],
    findings: { introduced: [], resolved: [] },
    stageSkew: [{ identity: 'Exchange 1§0', baseline: 0.7185185185185186, candidate: 1.5, delta: -0.78 }],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByText('0.72×')).toBeInTheDocument();
  expect(screen.getByText('1.50×')).toBeInTheDocument();
  expect(screen.queryByText('0.7185185185185186')).not.toBeInTheDocument();
});

test('drill-in links invoke onDrillIn for each run', async () => {
  const user = userEvent.setup();
  const onDrillIn = vi.fn();
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [],
    findings: { introduced: [], resolved: [] }, stageSkew: [],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} onDrillIn={onDrillIn} />);
  await user.click(screen.getByRole('button', { name: /view run a dashboard/i }));
  expect(onDrillIn).toHaveBeenCalledWith('baseline');
  await user.click(screen.getByRole('button', { name: /view run b dashboard/i }));
  expect(onDrillIn).toHaveBeenCalledWith('candidate');
});

test('new aggregate metrics render with byte/duration units, not raw numbers', () => {
  const model = {
    baselineLabel: 'base.log', candidateLabel: 'cand.log',
    confidence: 'ok', reason: null, matchedCoverage: 1,
    metrics: [
      { key: 'diskSpill', label: 'Disk spill', baseline: 2_000_000, candidate: 1_000_000, delta: -1_000_000, direction: 'improvement' },
      // candidate deliberately != baseline: formatDuration(5000) === formatDuration(5000) would
      // render the same text in both columns, and getByText throws on duplicate matches.
      { key: 'gcTime', label: 'GC time', baseline: 5000, candidate: 3000, delta: -2000, direction: 'improvement' },
    ],
    findings: { introduced: [], resolved: [] }, stageSkew: [],
  };
  render(<RunComparison model={model as any} onClose={vi.fn()} />);
  expect(screen.getByText('2 MB')).toBeInTheDocument();     // formatBytes, not "2000000"
  expect(screen.getByText('-1 MB')).toBeInTheDocument();    // signed delta via formatBytes
  expect(screen.getByText('5.0s')).toBeInTheDocument();     // formatDuration for GC time (confirmed via node: formatDuration(5000) === '5.0s', not '5s')
});
