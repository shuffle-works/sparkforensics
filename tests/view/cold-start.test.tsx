// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { emptyAppModel } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';

import { ColdStart } from '@/view/widgets/ColdStart';

test('renders nothing when the catalog has no coldStart findings', () => {
  const { container } = render(<ColdStart appModel={emptyAppModel()} catalog={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('renders the WidgetCard heading, COLD tag, the measured metric value, and its recommendation', () => {
  const catalog: Finding[] = [
    { type: 'coldStart', stageId: null, impactBand: 'warning', value: 45, recommendation: 'Consider pre-warming the cluster.' },
  ];
  render(<ColdStart appModel={emptyAppModel()} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.getByRole('heading', { name: 'Cold Start' })).toBeInTheDocument();
  expect(screen.getAllByText('COLD').length).toBeGreaterThan(0);
  expect(screen.getByText('45s', { selector: 'strong' })).toBeInTheDocument();
  expect(screen.getByText('Consider pre-warming the cluster.')).toBeInTheDocument();
});

test('shows the COLD tag once, in the header, and keeps a per-row impact dot for every flagged finding', () => {
  const catalog: Finding[] = [
    { type: 'coldStart', stageId: null, impactBand: 'warning', value: 45, recommendation: 'r1' },
  ];
  const { container } = render(<ColdStart appModel={emptyAppModel()} catalog={catalog} defaultCollapsed />);

  expect(screen.getByText('COLD')).toBeInTheDocument();
  // One dot inside the header TagBadge itself, plus one per flagged row.
  expect(container.querySelectorAll('.size-2.rounded-full')).toHaveLength(2);
});

test('renders no StagePill (coldStart is app-scoped, stageId is always null)', () => {
  const catalog: Finding[] = [
    { type: 'coldStart', stageId: null, impactBand: 'warning', value: 45, recommendation: 'r' },
  ];
  render(<ColdStart appModel={emptyAppModel()} catalog={catalog} defaultCollapsed={false} />);
  expect(screen.queryByRole('button', { name: /open details for stage/i })).not.toBeInTheDocument();
});

test('renders the impact estimate for a flagged finding', () => {
  const catalog: Finding[] = [
    { type: 'coldStart', stageId: null, impactBand: 'warning', value: 45, recommendation: 'r', impactEstimate: { basis: 'serial', wallClock: { low: 45000, high: 45000 }, estimateMethod: 'measured' } },
  ];
  render(<ColdStart appModel={emptyAppModel()} catalog={catalog} defaultCollapsed={false} />);
  expect(document.querySelector('.impact-estimate')).toHaveTextContent('45.0s');
});
