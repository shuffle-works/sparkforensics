// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { RunComparison } from '@/view/RunComparison';
import { compareRuns } from '@sparkforensics/core/run-comparison.ts';

// One stage and `executors` two-core executors alive for the whole run window.
const run = (label: string, { wallMs, executors, taskMs, config }: { wallMs: number; executors: number; taskMs: number; config: Record<string, string> }): any => ({
  label,
  snapshot: {
    app: { id: label, name: 'Job', startTime: 0, endTime: wallMs, config },
    stages: new Map<number, any>([[1, {
      id: 1, name: 'scan', submittedAt: 0, completedAt: wallMs, taskCount: 10,
      executorRunTime: taskMs, inputBytes: 5000, outputBytes: 2000, outputRecords: 1000,
    }]]),
    sql: new Map(), catalog: [], jobs: new Map(), runAggregates: null, evidenceAvailability: null, taskData: new Map(),
    executors: { added: Array.from({ length: executors }, (_, i) => ({ executorId: String(i), timestamp: 0, totalCores: 2 })), removed: [] },
  },
});

const model = (candConfig: Record<string, string> = { a: '1' }) => compareRuns(
  run('base.log', { wallMs: 100_000, executors: 4, taskMs: 400_000, config: { a: '1' } }),
  run('cand.log', { wallMs: 150_000, executors: 2, taskMs: 300_000, config: candConfig }),
);

test('shows what differs between the runs and reads equal runs as equivalent', () => {
  render(<RunComparison model={model() as any} onClose={vi.fn()} />);
  const verdict = screen.getByTestId('comparison-verdict');
  expect(verdict).toHaveAttribute('data-tone', 'equivalent');
  expect(within(verdict).getByRole('heading', { level: 2 }).textContent).toMatch(/^Same configuration, plan and output\. Time differs by 50\.0s \(50%\): executors averaged 4\.0 in the baseline and 2\.0 in the candidate/);

  const card = screen.getByTestId('comparability-card');
  expect(within(card).getByRole('heading', { level: 3, name: 'What differs between the runs' })).toBeInTheDocument();
  expect(within(card).getByRole('row', { name: 'Spark configuration' })).toHaveTextContent('Same');
  expect(within(card).getByRole('row', { name: 'Plan' })).toHaveTextContent('Every stage pairs');
  expect(within(card).getByRole('row', { name: 'Output rows' })).toHaveTextContent(/1\W?000/);
  expect(within(card).getByRole('row', { name: 'Output rows' })).toHaveTextContent('Equal');
  expect(within(card).getByRole('row', { name: 'Executors, mean' })).toHaveTextContent('4.0');
  expect(within(card).getByRole('row', { name: 'Executors, mean' })).toHaveTextContent('2.0');
  expect(within(card).getByRole('row', { name: 'Executors, mean' })).toHaveTextContent('×0.50');
  expect(card).toHaveTextContent('The runs overlapped for 1m 40s.');
  expect(card).toHaveTextContent('Wall clock ×1.50 follows from task time ×0.75 over mean executors ×0.50');
});

test('lists the configuration keys that differ, by name and both values', () => {
  render(<RunComparison model={model({ a: '2', b: 'on' }) as any} onClose={vi.fn()} />);
  const card = screen.getByTestId('comparability-card');
  expect(within(card).getByRole('row', { name: 'Spark configuration' })).toHaveTextContent('2 differ');
  const list = within(card).getByRole('list', { name: 'Configuration differences' });
  expect(list).toHaveTextContent('a: 1 → 2');
  expect(list).toHaveTextContent('b: not set → on');
  expect(screen.getByTestId('comparison-verdict')).not.toHaveAttribute('data-tone', 'equivalent');
});

test('shows no card for a hand-built model without comparability', () => {
  const bare = { baselineLabel: 'b', candidateLabel: 'c', confidence: 'ok', reason: null, matchedCoverage: 1, metrics: [], findings: { introduced: [], resolved: [] }, stageSkew: [] };
  render(<RunComparison model={bare as any} onClose={vi.fn()} />);
  expect(screen.queryByTestId('comparability-card')).toBeNull();
});
