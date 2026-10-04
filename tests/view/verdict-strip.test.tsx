// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

import { emptyAppModel, store } from '@/store/store';
import { Table, TableBody } from '@/components/ui/table';
import { computeRunEndSec, formatRunClock, runClockTicks } from '@/view/charts/run-clock';
import { stepCodes } from '@/view/interpretation';
import { StageDetailProvider } from '@/view/StageDetailContext';
import { FindingRow } from '@/view/widgets/FixTheseFirst';
import { StageTable } from '@/view/widgets/StageTable';
import { VerdictStrip } from '@/view/widgets/VerdictStrip';
import type { AppModel, Finding, FindingType, ImpactBand } from '@sparkforensics/core/types.ts';
import { installInterpretation } from './_shared/interpretation';

function timed(type: FindingType, stageId: number, highMs: number, impactBand: ImpactBand = 'critical'): Finding {
  return {
    type,
    impactBand,
    stageId,
    recommendation: `Fix ${type} in Stage ${stageId}.`,
    impactEstimate: { basis: 'serial', wallClock: { low: highMs, high: highMs }, estimateMethod: 'modeled' },
  } as unknown as Finding;
}

// A 17.2s run: three stages, Stage 7 the long tail.
function run(): AppModel {
  return {
    ...emptyAppModel(),
    app: { startTime: 1000, endTime: 18_200 },
    stages: new Map([
      [0, { id: 0, name: 's0', submittedAt: 4300, completedAt: 9200, taskCount: 2 }],
      [3, { id: 3, name: 's3', submittedAt: 8900, completedAt: 9900, taskCount: 2 }],
      [7, { id: 7, name: 's7', submittedAt: 10_100, completedAt: 18_100, taskCount: 200 }],
    ]),
  } as AppModel;
}

function install(catalog: Finding[], model: AppModel = run()) {
  store.setState({ appModel: model });
  return installInterpretation(catalog, model);
}

afterEach(() => {
  cleanup();
  store.setState({ appModel: emptyAppModel() });
});

describe('run clock helpers', () => {
  it('measures the run from app start and ends its ticks on the real run length', () => {
    expect(computeRunEndSec(run())).toBeCloseTo(17.2);
    expect(runClockTicks(17.2, 6)).toEqual([0, 5, 10, 17.2]);
    expect(formatRunClock(17.2)).toBe('17.2s');
    expect(formatRunClock(245)).toBe('4m05s');
  });

  it('has no run length without timings', () => {
    expect(computeRunEndSec(emptyAppModel())).toBeNull();
  });
});

describe('step codes', () => {
  it('codes each verdict step F1..Fn by its lead finding and its stage', () => {
    const skew = timed('skew', 7, 2_400);
    const spill = timed('spill', 3, 1_000, 'warning');
    const codes = stepCodes(install([skew, spill]));
    expect(codes.byFinding.get(skew)).toBe('F1');
    expect(codes.byFinding.get(spill)).toBe('F2');
    expect(codes.byStage.get(7)).toBe('F1');
    expect(codes.byStage.get(3)).toBe('F2');
  });
});

describe('VerdictStrip', () => {
  it('draws each stage on the run clock and marks the step stage with its code and status', () => {
    const interpretation = install([timed('skew', 7, 2_400)]);
    render(<VerdictStrip interpretation={interpretation} />);

    const strip = screen.getByTestId('verdict-strip');
    expect(strip).toHaveAttribute('role', 'img');
    expect(strip.getAttribute('aria-label')).toMatch(/All 3 stages on the run clock, 17\.2s total\. Step F1: Stage 7/);
    const row = strip.querySelector('[data-step-code="F1"]')!;
    expect(row).toHaveTextContent('stage 7');
    expect(row.querySelector('.bg-critical')).not.toBeNull();
    expect(strip.querySelectorAll('.verdict-strip__bar--neutral')).toHaveLength(2);
    expect(strip).toHaveTextContent('17.2s');
  });

  it('renders nothing when the run has no timing', () => {
    const interpretation = install([], emptyAppModel());
    const { container } = render(<VerdictStrip interpretation={interpretation} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('step codes on the board', () => {
  it('shows the step code on the lead finding\'s Findings row and its Stage Summary row', () => {
    const skew = timed('skew', 7, 2_400);
    const straggler = timed('straggler', 7, 2_300);
    install([skew, straggler]);
    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <FindingRow finding={skew} allFindings={[skew, straggler]} onRoute={() => {}} />
            <FindingRow finding={straggler} allFindings={[skew, straggler]} onRoute={() => {}} />
          </TableBody>
        </Table>
        <StageTable appModel={run()} catalog={[skew, straggler]} getTaskData={async () => ({ metrics: [], fieldNames: [] })} />
      </StageDetailProvider>,
    );
    const rows = screen.getAllByTestId('fix-these-first-row');
    expect(rows[0].querySelector('[data-step-code="F1"]')).not.toBeNull();
    expect(rows[1].querySelector('[data-step-code]')).toBeNull();

    const stageRow = screen.getByRole('button', { name: 'Open Stage 7 details' }).closest('tr')!;
    expect(within(stageRow).getByText('F1')).toHaveAttribute('data-step-code', 'F1');
    expect(stageRow).toHaveAttribute('data-flag', 'critical');
  });
});
