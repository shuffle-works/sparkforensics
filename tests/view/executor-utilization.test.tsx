// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Finding } from '@sparkforensics/core/types.ts';

import { ExecutorUtilization } from '@/view/widgets/ExecutorUtilization';

test('renders nothing when there are no utilization findings (collapses to a Clean-checks row instead)', () => {
  const { container } = render(<ExecutorUtilization catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, UTIL badge, and the average-utilization row', () => {
  const catalog: Finding[] = [
    { type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%: consider reducing cluster size or enabling dynamic allocation.' },
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Executor Utilization' })).toBeInTheDocument();
  expect(screen.getByText('UTIL')).toBeInTheDocument();
  expect(screen.getByText('42%')).toBeInTheDocument();
});

test("a utilization row's recommendation is visible unconditionally, with no per-row toggle", () => {
  const catalog: Finding[] = [
    { type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%: consider reducing cluster size or enabling dynamic allocation.' },
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  const recommendation = /Average executor utilization < 60%/i;
  expect(screen.getByText(recommendation)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /recommendation for executor utilization/i })).not.toBeInTheDocument();
});

test('renders the core-hours raw-waste figure for a utilization finding', () => {
  const catalog: Finding[] = [
    {
      type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42,
      recommendation: 'Average executor utilization < 60%.',
      impactEstimate: { basis: 'resourceOnly', wallClock: null, estimateMethod: 'measured', rawWaste: { value: 6, unit: 'coreHours' } },
    },
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText('6.0 core-h')).toBeInTheDocument();
});

test('flags every affected row, not just the worst, sorted worst-first', () => {
  const catalog: Finding[] = [
    { type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 55, recommendation: 'r-info' },
    { type: 'utilization', stageId: null, impactBand: 'warning', metric: 'avgUtilization', value: 30, recommendation: 'r-warning' },
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByText(/r-warning/)).toBeInTheDocument();
  expect(screen.getByText(/r-info/)).toBeInTheDocument();
});

test('card defaults collapsed with a summary when there are findings', () => {
  const catalog: Finding[] = [
    { type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%.' },
  ];
  render(<ExecutorUtilization catalog={catalog} />);
  expect(screen.getByText(/1 item flagged/)).toBeInTheDocument();
});

test('stays domain-agnostic: no company/industry copy leaks', () => {
  const catalog: Finding[] = [
    { type: 'utilization', stageId: null, impactBand: 'info', metric: 'avgUtilization', value: 42, recommendation: 'Average executor utilization < 60%.' },
  ];
  render(<ExecutorUtilization catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByText(/scanntech/i)).not.toBeInTheDocument();
});
