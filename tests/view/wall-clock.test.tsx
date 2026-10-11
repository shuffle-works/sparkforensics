// @vitest-environment jsdom
import path from 'node:path';
import { test, expect } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WallClock } from '../../src/view/widgets/WallClock';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { store } from '../../src/store/store';
import { installInterpretation } from './_shared/interpretation';
import { contrastRatio, installStylesheet, resolvedColor } from './_shared/css-contrast';

// The widget renders the store's interpretation of the run, as the dashboard installs it.
function renderWallClock(appModel: AppModel) {
  installInterpretation([], appModel);
  return render(<WallClock />);
}

function makeAppModel(overrides: Partial<AppModel> = {}): AppModel {
  return {
    app: { startTime: 0, endTime: 100_000 },
    stages: new Map([
      [1, { id: 1, submittedAt: 10_000, completedAt: 40_000 }],
      [2, { id: 2, submittedAt: 60_000, completedAt: 80_000 }],
    ]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map(),
    runAggregates: null,
    ...overrides,
    evidenceAvailability: overrides.evidenceAvailability ?? null,
  };
}

test('renders the WidgetCard heading and total wall-clock duration', () => {
  renderWallClock(makeAppModel());
  expect(screen.getByRole('heading', { name: /wall-clock breakdown/i })).toBeInTheDocument();
  expect(screen.getByText(/1m 40s/)).toBeInTheDocument();
});

test('renders a segment for each non-zero wall-clock component', () => {
  renderWallClock(makeAppModel());
  expect(screen.getAllByText('Startup').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Stages active').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Scheduler gaps').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Idle').length).toBeGreaterThan(0);
});

test.each(['dark', 'light'])('every legend label renders in the text color with 4.5:1 on the %s panel and canvas', (theme) => {
  // Recharts colors each label with its series fill inline; pale series colors fail WCAG AA as text.
  const removeStylesheet = installStylesheet(document, path.join(__dirname, '../../src/index.css'));
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  try {
    renderWallClock(makeAppModel());
    for (const name of ['Startup', 'Stages active', 'Scheduler gaps', 'Idle']) {
      const label = screen.getAllByText(name).find((el) => el.closest('.recharts-legend-item-text'));
      expect(label, name).toBeDefined();
      const color = resolvedColor(label!, 'color');
      expect(color, name).toBe(resolvedColor(label!, '--text'));
      for (const surface of ['--surface', '--bg']) {
        expect(contrastRatio(color, resolvedColor(label!, surface)), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  } finally {
    delete document.documentElement.dataset.theme;
    removeStylesheet();
  }
});

test('omits a segment entirely when its value is zero (no startup gap here)', () => {
  const appModel = makeAppModel({
    app: { startTime: 10_000, endTime: 50_000 },
    stages: new Map([[1, { id: 1, submittedAt: 10_000, completedAt: 50_000 }]]),
  });
  renderWallClock(appModel);
  expect(screen.queryByText('Startup')).not.toBeInTheDocument();
  expect(screen.queryByText('Scheduler gaps')).not.toBeInTheDocument();
  expect(screen.queryByText('Idle')).not.toBeInTheDocument();
  expect(screen.getAllByText('Stages active').length).toBeGreaterThan(0);
});

test('renders nothing when total wall-clock time is zero', () => {
  const appModel = makeAppModel({ app: { startTime: 0, endTime: 0 }, stages: new Map() });
  const { container } = renderWallClock(appModel);
  expect(container).toBeEmptyDOMElement();
});

test('renders no domain/company strings', () => {
  const { container } = renderWallClock(makeAppModel());
  expect(container.textContent).not.toMatch(/scanntech|retail|cpg|latin america/i);
});

test('the segment legend is Advanced-only; the bar itself stays visible at Basic', () => {
  const fixture = makeAppModel();
  store.getState().setWidgetDensity('basic');
  renderWallClock(fixture);
  expect(screen.getByRole('img', { name: /wall-clock breakdown/i })).toBeInTheDocument();
  expect(screen.queryByText(/^Startup \(/)).not.toBeInTheDocument();

  cleanup();
  store.getState().setWidgetDensity('advanced');
  renderWallClock(fixture);
  expect(screen.getByText(/^Startup \(/)).toBeInTheDocument();
  store.getState().setWidgetDensity('basic');
});

test('renders the dominant segment label and percentage in the collapsed-state summary', async () => {
  const user = userEvent.setup();
  renderWallClock(makeAppModel());
  // The appModel has stages from 10k-40k (30k ms) and 60k-80k (20k ms), plus startup (10k), gaps, and idle.
  // Stages active (30k) should be the dominant segment, so the summary should show "Stages active 50%".
  // The summary is only visible when the card is collapsed, so click the trigger to collapse it.
  const trigger = screen.getByRole('button', { name: /wall-clock breakdown/i });
  await user.click(trigger);
  expect(screen.getByText('Stages active 50%')).toBeInTheDocument();
});
