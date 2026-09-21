// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, test, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AutoscalingChurn, bucketChurn } from '../../src/view/widgets/AutoscalingChurn';
import { emptyAppModel } from '../../src/store/store';
import { DocsProvider } from '../../src/view/DocsContext';
import type { AppModel } from '@sparkforensics/core/types.ts';

// The percentage sits in a `<strong>`, so it spans multiple elements; match by
// the full textContent of the containing element rather than RTL's getByText.
function fullTextOf(expected: string) {
  return (_content: string, element: Element | null) => element?.textContent === expected;
}

// Mock calls through to the real downsample; the memoization test below reads its call count.
vi.mock('../../src/view/charts/downsample', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/view/charts/downsample')>();
  return { downsample: vi.fn(actual.downsample) };
});
const { downsample } = await import('../../src/view/charts/downsample');

function makeAppModel(overrides: Partial<AppModel> = {}): AppModel {
  return { ...emptyAppModel(), ...overrides };
}

describe('bucketChurn', () => {
  it('counts adds and removes per bucket, keeping zero-churn buckets (ported verbatim from src/widgets/autoscaling-churn.js)', () => {
    const added = [{ timestamp: 0 }, { timestamp: 500 }, { timestamp: 2500 }];
    const removed = [{ timestamp: 2600 }];
    const b = bucketChurn(added, removed, 0, 3000, 1000);
    expect(b).toEqual([
      { tStart: 0, adds: 2, removes: 0 },
      { tStart: 1000, adds: 0, removes: 0 },
      { tStart: 2000, adds: 1, removes: 1 },
    ]);
  });

  it('returns [] when there are no events', () => {
    expect(bucketChurn([], [], 0, 1000, 1000)).toEqual([]);
  });
});

describe('AutoscalingChurn', () => {
  it('renders the WidgetCard heading and a chart region when executor churn events exist', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 60_000 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} />
      </DocsProvider>,
    );

    expect(screen.getByRole('heading', { name: /autoscaling churn/i })).toBeInTheDocument();
    // Card is collapsed by default; expand it to reach the chart region.
    await user.click(screen.getByRole('button', { name: /autoscaling churn/i }));
    expect(screen.getByRole('img', { name: /added and remove/i })).toBeInTheDocument();
  });

  it('renders the added/removed subtitle and a legend with both series when churn events exist', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} />
      </DocsProvider>,
    );

    expect(screen.getByText(/executors added \/ removed over time/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /autoscaling churn/i }));
    expect(screen.getByText('Added')).toBeInTheDocument();
    expect(screen.getByText('Removed')).toBeInTheDocument();
  });

  it('links the recommendation to the autoscale-bounds tuning doc when a churn finding is flagged', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 60_000 }] as unknown as AppModel['executors']['removed'],
      },
    });
    const finding = {
      type: 'autoscalingChurn', stageId: null, impactBand: 'critical' as const,
      metric: 'shortLivedExecutorPct', value: 70, confidence: 'low',
      recommendation: '70% of executors ran for under 2 minutes before being removed.',
    };

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} catalog={[finding]} />
      </DocsProvider>,
    );

    await user.click(screen.getByRole('button', { name: /^autoscaling churn$/i }));
    const link = screen.getByRole('link', { name: /tuning executorIdleTimeout/i });
    expect(link.getAttribute('href')).toContain('#config-autoscale-bounds');
  });

  it('renders a muted no-churn message and no chart region when there are no executor events', () => {
    const appModel = makeAppModel({ app: { startTime: 0, endTime: 1000 } as AppModel['app'] });

    render(<AutoscalingChurn appModel={appModel} />);

    expect(screen.getByRole('heading', { name: /autoscaling churn/i })).toBeInTheDocument();
    expect(screen.getByText(/no executor add\/remove events/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /learn more/i })).not.toBeInTheDocument();
  });

  it('renders an impact-band banner (dot + CHRN tag + recommendation) when an autoscalingChurn finding is present', async () => {
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 60_000 }] as unknown as AppModel['executors']['removed'],
      },
    });
    const finding = {
      type: 'autoscalingChurn', stageId: null, impactBand: 'critical' as const,
      metric: 'shortLivedExecutorPct', value: 70, confidence: 'low',
      recommendation: '70% of executors ran for under 2 minutes before being removed, this looks like wasteful re-provisioning rather than normal scale-down. Consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.',
    };

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} catalog={[finding]} />
      </DocsProvider>,
    );

    expect(screen.getByText('CHRN')).toBeInTheDocument();
    expect(screen.getByText(fullTextOf('Short-lived executors: 70%'))).toBeInTheDocument();
    expect(screen.getByText(/70% of executors ran for under 2 minutes/i)).toBeInTheDocument();
  });

  it('renders the core-hours raw-waste figure when an autoscalingChurn finding carries an impactEstimate', async () => {
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 60_000 }] as unknown as AppModel['executors']['removed'],
      },
    });
    const finding = {
      type: 'autoscalingChurn', stageId: null, impactBand: 'critical' as const,
      metric: 'shortLivedExecutorPct', value: 70,
      recommendation: '70% of executors ran for under 2 minutes before being removed.',
      impactEstimate: { basis: 'resourceOnly' as const, wallClock: null, estimateMethod: 'measured' as const, rawWaste: { value: 3, unit: 'coreHours' as const } },
    };

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} catalog={[finding]} />
      </DocsProvider>,
    );

    expect(screen.getByText('3.0 core-h')).toBeInTheDocument();
  });

  it('shows the short-lived-executor stat and the recommendation unconditionally, with no per-row toggle', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 60_000 }] as unknown as AppModel['executors']['removed'],
      },
    });
    const finding = {
      type: 'autoscalingChurn', stageId: null, impactBand: 'critical' as const,
      metric: 'shortLivedExecutorPct', value: 70,
      recommendation: 'Consider raising spark.dynamicAllocation.executorIdleTimeout.',
    };

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} catalog={[finding]} />
      </DocsProvider>,
    );

    // Card is collapsed by default; expand it to reach the row content.
    await user.click(screen.getByRole('button', { name: /^autoscaling churn$/i }));

    // Stat line and recommendation both render unconditionally, with no per-row toggle.
    expect(screen.getByText(fullTextOf('Short-lived executors: 70%'))).toBeInTheDocument();
    expect(screen.getByText(/Consider raising spark\.dynamicAllocation\.executorIdleTimeout\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hide recommendation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show recommendation/i })).not.toBeInTheDocument();
  });

  it('renders no impact-band banner when no autoscalingChurn finding is present, preserving the descriptive-only chart', async () => {
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} catalog={[]} />
      </DocsProvider>,
    );

    expect(screen.queryByText('CHRN')).not.toBeInTheDocument();
    expect(screen.getByText(/executors added \/ removed over time/i)).toBeInTheDocument();
  });

  it('downsamples a large bucketed churn series to the shared chart budget', () => {
    // bucketChurn is width-driven: a pathologically fine bucket width is how a
    // series this large reaches the same downsample() pipeline the widget uses.
    const buckets = bucketChurn([{ timestamp: 0 }], [], 0, 10_000_000, 1);
    expect(buckets.length).toBeGreaterThan(2000);

    const sampled = downsample(buckets);
    expect(sampled.length).toBeLessThanOrEqual(2000);
    expect(sampled[0]).toEqual(buckets[0]);
    expect(sampled.at(-1)).toEqual(buckets.at(-1));
  });

  it('exposes a data table matching the chart series, hidden by default', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });

    render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} />
      </DocsProvider>,
    );

    await user.click(screen.getByRole('button', { name: /^autoscaling churn$/i }));
    await user.click(screen.getByRole('button', { name: /table/i }));

    expect(screen.getByRole('columnheader', { name: 'Time' })).toHaveClass('text-right');
    expect(screen.getByRole('columnheader', { name: 'Executors added' })).toHaveClass('text-right');
    expect(screen.getByRole('columnheader', { name: 'Executors removed' })).toHaveClass('text-right');
  });

  it('is wrapped in React.memo', () => {
    expect((AutoscalingChurn as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  // The derived churn series is memoized on `appModel`, so an unrelated
  // re-render must not rerun bucketChurn + downsample.
  test('does not recompute the churn series when an unrelated re-render occurs with the same appModel', async () => {
    const user = userEvent.setup();
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 60_000 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });
    const callsBefore = (downsample as Mock).mock.calls.length;

    function Harness() {
      const [, setTick] = useState(0);
      return (
        <DocsProvider>
          <button onClick={() => setTick((t) => t + 1)}>tick</button>
          <AutoscalingChurn appModel={appModel} />
        </DocsProvider>
      );
    }

    render(<Harness />);
    expect((downsample as Mock).mock.calls.length - callsBefore).toBe(1);

    await user.click(screen.getByRole('button', { name: 'tick' }));
    expect((downsample as Mock).mock.calls.length - callsBefore).toBe(1);
  });

  // Regression: applySnapshot mutates the live appModel's fields in place (not
  // replacing the object), so a cached-file switch must not leave this widget
  // showing the previous file's churn counts when appModel's reference is unchanged.
  test('reflects a new file after appModel is mutated in place and activeFileId changes (cached-file switch)', async () => {
    const appModel = makeAppModel({
      app: { startTime: 0, endTime: 120_000 } as AppModel['app'],
      executors: {
        added: [{ timestamp: 0 }, { timestamp: 60_000 }] as unknown as AppModel['executors']['added'],
        removed: [{ timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
      },
    });

    const { rerender } = render(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} activeFileId="file-a" />
      </DocsProvider>,
    );
    // The bucketed churn series handed to `downsample` is the observable: it's
    // what the `activeFileId` memo key is there to recompute.
    const churnTotals = () => {
      const buckets = (downsample as Mock).mock.lastCall![0] as { adds: number; removes: number }[];
      return buckets.reduce(
        (acc, b) => ({ adds: acc.adds + b.adds, removes: acc.removes + b.removes }),
        { adds: 0, removes: 0 },
      );
    };
    expect(churnTotals()).toEqual({ adds: 2, removes: 1 });

    // Mimic applySnapshot: mutate the same appModel's `executors` in place.
    appModel.executors = {
      added: [{ timestamp: 0 }] as unknown as AppModel['executors']['added'],
      removed: [{ timestamp: 30_000 }, { timestamp: 60_000 }, { timestamp: 90_000 }] as unknown as AppModel['executors']['removed'],
    };

    rerender(
      <DocsProvider>
        <AutoscalingChurn appModel={appModel} activeFileId="file-b" />
      </DocsProvider>,
    );

    expect(churnTotals()).toEqual({ adds: 1, removes: 3 });
    expect(screen.queryByText('2 added / 1 removed')).not.toBeInTheDocument();
  });
});
