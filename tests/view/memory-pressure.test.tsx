// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emptyAppModel } from '@/store/store';
import { MemoryPressure } from '@/view/widgets/MemoryPressure';
import { DocsProvider } from '@/view/DocsContext';
import type { AppModel } from '@sparkforensics/core/types.ts';

// Fixture matches runtime stage shape (id, not the Stage type's stageId), cast to AppModel['stages'].
function buildAppModel(stageOverrides: Record<number, Record<string, unknown>> = {}): AppModel {
  const stages = new Map<number, unknown>([
    [1, { id: 1, memoryBytesSpilled: 600 * 1024 * 1024, gcPct: 15, submittedAt: 200 }],
    [2, { id: 2, memoryBytesSpilled: 50 * 1024 * 1024, gcPct: 2, submittedAt: 100 }],
  ]);
  for (const [id, overrides] of Object.entries(stageOverrides)) {
    stages.set(Number(id), { ...(stages.get(Number(id)) as object), ...overrides });
  }
  return { ...emptyAppModel(), stages: stages as unknown as AppModel['stages'] };
}

test('renders both chart regions, with the scatter view active by default', () => {
  render(
    <DocsProvider>
      <MemoryPressure appModel={buildAppModel()} />
    </DocsProvider>,
  );

  expect(screen.getByRole('tab', { name: /scatter/i })).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /twin/i })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /scatter/i })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /by stage/i })).not.toBeInTheDocument();
});

test('renders a doc link pointing at the memory-model anchor', () => {
  render(
    <DocsProvider>
      <MemoryPressure appModel={buildAppModel()} />
    </DocsProvider>,
  );

  const link = screen.getByRole('link', { name: /how spark.s memory model works/i });
  expect(link.getAttribute('href')).toContain('#memory-model');
});

test('toggling the view switch swaps which chart region is shown', async () => {
  render(
    <DocsProvider>
      <MemoryPressure appModel={buildAppModel()} />
    </DocsProvider>,
  );

  const twinTab = screen.getByRole('tab', { name: /twin/i });
  await userEvent.click(twinTab);

  expect(twinTab).toHaveAttribute('aria-selected', 'true');
  expect(screen.getByRole('img', { name: /by stage/i })).toBeInTheDocument();
  expect(screen.queryByRole('img', { name: /scatter/i })).not.toBeInTheDocument();
});

test('shows a fallback message and no view switch when no stage spilled memory', () => {
  const model = buildAppModel({ 1: { memoryBytesSpilled: 0 }, 2: { memoryBytesSpilled: 0 } });
  render(<MemoryPressure appModel={model} />);

  expect(screen.getByText(/no stages spilled/i)).toBeInTheDocument();
  expect(screen.queryByRole('tab')).not.toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
});

test('exposes a data table for the scatter view matching its points', async () => {
  const user = userEvent.setup();
  render(
    <DocsProvider>
      <MemoryPressure appModel={buildAppModel()} />
    </DocsProvider>,
  );

  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Stage' })).not.toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'Memory spilled' })).toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'GC %' })).toHaveClass('text-right');
  // Two stages spilled (stage 1: 600MB, stage 2: 50MB) in the default fixture.
  expect(screen.getAllByRole('row')).toHaveLength(3); // header + 2 data rows
});

test('exposes a data table for the twin-bars view matching its data', async () => {
  const user = userEvent.setup();
  render(
    <DocsProvider>
      <MemoryPressure appModel={buildAppModel()} />
    </DocsProvider>,
  );

  await user.click(screen.getByRole('tab', { name: /twin/i }));
  await user.click(screen.getByRole('button', { name: /table/i }));

  expect(screen.getByRole('columnheader', { name: 'Stage' })).not.toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'Spill (MB)' })).toHaveClass('text-right');
  expect(screen.getByRole('columnheader', { name: 'GC %' })).toHaveClass('text-right');
  expect(screen.getAllByRole('row')).toHaveLength(3);
});
