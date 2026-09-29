// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';

import { ExecutorUtilization } from '@/view/widgets/ExecutorUtilization';
import { installInterpretation } from './_shared/interpretation';
import { testFinding } from './_shared/finding';

test('renders nothing when there are no utilization findings (collapses to a Clean-checks row instead)', () => {
  const { container } = render(<ExecutorUtilization catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, UTIL badge, and the average-utilization row', () => {
  const catalog: Finding[] = [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%: consider reducing cluster size or enabling dynamic allocation.', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Executor Utilization' })).toBeInTheDocument();
  expect(screen.getByText('UTIL')).toBeInTheDocument();
  expect(screen.getByText('42%')).toBeInTheDocument();
});

test("the card's fix is visible unconditionally, with no per-row toggle", () => {
  const catalog: Finding[] = [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%: consider reducing cluster size or enabling dynamic allocation.', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('Consider reducing cluster size or enabling dynamic allocation.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /recommendation for executor utilization/i })).not.toBeInTheDocument();
});

test('renders the core-hours raw-waste figure for a utilization finding', () => {
  const catalog: Finding[] = [
    testFinding({
      type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42,
      recommendation: 'Average executor utilization < 60%.',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } },
      utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42,
    }),
  ];
  installInterpretation(catalog);
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('6.0 core-h')).toBeInTheDocument();
});

test('flags every affected row, not just the worst, sorted worst-first', () => {
  const catalog: Finding[] = [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 55, recommendation: 'r-info', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
    testFinding({ type: 'utilization', stageId: null, impactBand: 'warning', metric: 'avgUtilization', value: 30, recommendation: 'r-warning', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('30%')).toBeInTheDocument();
  expect(screen.getByText('55%')).toBeInTheDocument();
});

test('card defaults collapsed with a summary when there are findings', () => {
  const catalog: Finding[] = [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%.', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
  ];
  render(<ExecutorUtilization catalog={catalog} />);
  expect(screen.getByText('1 finding')).toBeInTheDocument();
});

test('stays domain-agnostic: no company/industry copy leaks', () => {
  const catalog: Finding[] = [
    testFinding({ type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%.', utilizationFraction: 0.42, appDurationMs: 60_000, totalCores: 4, cpuUtilizationPct: 42 }),
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByText(/scanntech/i)).not.toBeInTheDocument();
});
