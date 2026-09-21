// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { downsample } from '../../src/view/charts/downsample';
import { DurationHistogram } from '../../src/view/charts/DurationHistogram';
import { ChartCopyBar, chartTableToTSV } from '../../src/view/charts/ChartTheme';

test('downsample caps to budget preserving endpoints', () => {
  const pts = Array.from({ length: 10000 }, (_, i) => i);
  const out = downsample(pts, 2000);
  expect(out.length).toBeLessThanOrEqual(2000);
  expect(out[0]).toBe(0);
  expect(out.at(-1)).toBe(9999);
});
test('histogram shows note under 5 tasks', () => {
  render(<DurationHistogram metrics={[10, 0]} fieldNames={['duration', 'gcTime']} markers={{}} />);
  expect(screen.getByText(/too few tasks/i)).toBeInTheDocument();
});
test('histogram renders the chart for 5+ tasks', () => {
  const durations = [100, 200, 300, 400, 500, 600];
  const metrics = durations.flatMap((d) => [d, 0]);
  const { container } = render(
    <DurationHistogram metrics={metrics} fieldNames={['duration', 'gcTime']} markers={{}} />,
  );
  expect(screen.getByText('Task duration')).toBeInTheDocument();
  expect(screen.queryByText(/too few tasks/i)).not.toBeInTheDocument();
  expect(container.querySelector('.recharts-bar')).not.toBeNull();
});

test('downsample is a no-op when points already fit the budget', () => {
  const pts = [1, 2, 3];
  const out = downsample(pts, 10);
  expect(out).toBe(pts);
});
test('downsample with budget <= 1 returns at most the first point', () => {
  const pts = [1, 2, 3];
  expect(downsample(pts, 1)).toEqual([1]);
  expect(downsample(pts, 0)).toEqual([1]);
  expect(downsample([], 1)).toEqual([]);
});

test('chartTableToTSV serializes columns and rows as tab-separated lines', () => {
  const tsv = chartTableToTSV(['A', 'B'], [[1, 'x'], [2, 'y']]);
  expect(tsv).toBe('A\tB\n1\tx\n2\ty');
});

test('ChartCopyBar toggle flips table visibility and aria-expanded', async () => {
  const user = userEvent.setup();
  render(<ChartCopyBar caption="Demo" columns={['A']} rows={[[1]]} />);

  const toggle = screen.getByRole('button', { name: /table/i });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

test('ChartCopyBar copy button writes TSV via navigator.clipboard when available', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

  render(<ChartCopyBar caption="Demo" columns={['A', 'B']} rows={[[1, 'x']]} />);
  await user.click(screen.getByRole('button', { name: /copy/i }));

  expect(writeText).toHaveBeenCalledWith('A\tB\n1\tx');
  // @ts-expect-error -- restore jsdom's default (no Clipboard API) for other tests in this file
  delete navigator.clipboard;
});

test('ChartCopyBar falls back to execCommand when navigator.clipboard is unavailable', async () => {
  const user = userEvent.setup();
  // userEvent.setup() installs its own clipboard stub; undefine it again so
  // this genuinely exercises the no-Clipboard-API fallback path.
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  const execCommand = vi.fn().mockReturnValue(true);
  document.execCommand = execCommand;

  render(<ChartCopyBar caption="Demo" columns={['A']} rows={[[1]]} />);
  await user.click(screen.getByRole('button', { name: /copy/i }));

  expect(execCommand).toHaveBeenCalledWith('copy');
});

test('ChartCopyBar falls back to execCommand when navigator.clipboard rejects', async () => {
  const user = userEvent.setup();
  const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  const execCommand = vi.fn().mockReturnValue(true);
  document.execCommand = execCommand;

  render(<ChartCopyBar caption="Demo" columns={['A']} rows={[[1]]} />);
  await user.click(screen.getByRole('button', { name: /copy/i }));

  expect(writeText).toHaveBeenCalledWith('A\n1');
  expect(execCommand).toHaveBeenCalledWith('copy');
});

test('ChartCopyBar does not announce success when execCommand reports failure', async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = vi.fn().mockReturnValue(false);

  render(<ChartCopyBar caption="Demo" columns={['A']} rows={[[1]]} />);
  await user.click(screen.getByRole('button', { name: /copy/i }));

  expect(screen.queryByText('Copied')).not.toBeInTheDocument();
});

test('ChartCopyBar removes its fallback textarea when execCommand throws', async () => {
  const user = userEvent.setup();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  document.execCommand = vi.fn(() => {
    throw new Error('copy unavailable');
  });

  render(<ChartCopyBar caption="Demo" columns={['A']} rows={[[1]]} />);
  await user.click(screen.getByRole('button', { name: /copy/i }));

  expect(document.body.querySelector('textarea')).toBeNull();
});

test('DurationHistogram exposes a data table matching its bins', async () => {
  const user = userEvent.setup();
  const durations = [100, 200, 300, 400, 500, 600];
  const metrics = durations.flatMap((d) => [d, 0]);
  render(<DurationHistogram metrics={metrics} fieldNames={['duration', 'gcTime']} markers={{}} />);

  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Duration bin' })).toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'Task count' })).toHaveClass('text-right');
});

test('DurationHistogram keeps its data controls outside the chart image semantics', () => {
  const durations = [100, 200, 300, 400, 500, 600];
  const metrics = durations.flatMap((d) => [d, 0]);
  render(<DurationHistogram metrics={metrics} fieldNames={['duration', 'gcTime']} markers={{}} />);

  const chartImage = screen.getByRole('img', { name: 'Task duration histogram' });
  const tableToggle = screen.getByRole('button', { name: /table/i });
  const dataTable = screen.getByRole('table');
  expect(chartImage).not.toContainElement(tableToggle);
  expect(chartImage).not.toContainElement(dataTable);
  expect(chartImage.parentElement).toContainElement(tableToggle);
});
