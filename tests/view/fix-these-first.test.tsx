// @vitest-environment jsdom
import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Table, TableBody } from '../../src/components/ui/table';
import { StageDetailProvider } from '../../src/view/StageDetailContext';
import { impactFigure } from '@sparkforensics/core/impact-format.ts';
import { TypeGroupRow, useFixTheseFirstData } from '../../src/view/widgets/FixTheseFirst';
import { rankedRollup } from '@sparkforensics/core/recommendation-rollup.ts';
import type { AppModel, Finding, ImpactBand } from '@sparkforensics/core/types.ts';
import { emptyAppModel } from '@/store/store';
import type { BoardGroup } from '@/view/interpretation';
import { installInterpretation } from './_shared/interpretation';

// Non-overlapping windows so a group's union-capped recoverableMsHigh equals
// the naive sum, without re-testing computeStageUnionMs's overlap math.
const STAGES = new Map(Array.from({ length: 20 }, (_, i) => [i + 1, { id: i + 1, submittedAt: i * 10_000, completedAt: i * 10_000 + 5_000 }]));

const APP_MODEL = { ...emptyAppModel(), stages: STAGES } as unknown as AppModel;

// The board as ImpactBoard reads it: the run's interpretation over these findings, unfiltered.
function boardData(catalog: Finding[], configFindings: Finding[] = []) {
  return useFixTheseFirstData(catalog, configFindings, APP_MODEL.stages, installInterpretation(catalog, APP_MODEL, configFindings));
}

// One board group for TypeGroupRow, built the way the interpretation builds it.
function groupOf(findings: Finding[]): BoardGroup {
  const [{ members, ...group }] = rankedRollup(findings, STAGES);
  return { ...group, key: `${group.kind}-${group.type}`, findings: members };
}

function findingWithMagnitude(type: string, stageId: number, lowMs: number, impactBand: ImpactBand = 'warning'): Finding {
  return {
    type,
    impactBand,
    stageId,
    recommendation: `Fix ${type} in Stage ${stageId}.`,
    impactEstimate: { basis: 'serial', wallClock: { low: lowMs, high: lowMs }, estimateMethod: 'modeled' },
  };
}

describe('useFixTheseFirstData', () => {
  it('bands a one-finding group by that finding', () => {
    const catalog = [findingWithMagnitude('spill', 1, 9000, 'critical')];
    const { groups } = boardData(catalog);
    expect(groups[0].band).toBe('critical');
  });

  it('bands a multi-finding group by its highest-impact member, not its worst band', () => {
    // Both merge into one group; the larger-magnitude info finding outranks
    // the smaller critical one for the badge.
    const highImpact = findingWithMagnitude('skew', 1, 5000, 'info');
    const lowerImpact = findingWithMagnitude('skew', 2, 1000, 'critical');
    const { groups } = boardData([highImpact, lowerImpact]);
    expect(groups).toHaveLength(1);
    expect(groups[0].band).toBe('info');
  });

  it('ranks group members by wallClock.high, not .low', () => {
    // A: low=1000/high=9000, B: low=5000/high=6000. Ranking by .high must pick A, not B.
    const findingA: Finding = {
      type: 'skew', impactBand: 'critical', stageId: 1,
      recommendation: 'Fix skew in Stage 1.',
      impactEstimate: { basis: 'contended', wallClock: { low: 1000, high: 9000 }, estimateMethod: 'measured' },
    };
    const findingB: Finding = {
      type: 'skew', impactBand: 'info', stageId: 2,
      recommendation: 'Fix skew in Stage 2.',
      impactEstimate: { basis: 'contended', wallClock: { low: 5000, high: 6000 }, estimateMethod: 'measured' },
    };
    const { groups } = boardData([findingB, findingA]);
    expect(groups).toHaveLength(1);
    expect(groups[0].band).toBe('critical');
  });

  it('useFixTheseFirstData returns the eligible/groups/triageTarget ImpactBoard renders from', () => {
    const catalog = [findingWithMagnitude('spill', 1, 9000, 'critical')];
    const { eligible, groups, triageTarget } = boardData(catalog);
    expect(eligible).toHaveLength(1);
    expect(groups).toHaveLength(1);
    expect(triageTarget?.finding).toBe(catalog[0]);
  });

  it('renders the unfiltered board exactly as the interpretation carries it', () => {
    const catalog = [findingWithMagnitude('spill', 1, 3000), findingWithMagnitude('spill', 2, 2000)];
    const state = installInterpretation(catalog, APP_MODEL);
    // A figure no core computes: the board must show the carried one, not derive its own.
    state.data.rollup.groups[0].stat = 'carried figure';
    const { groups } = useFixTheseFirstData(catalog, [], APP_MODEL.stages, state);
    expect(groups[0].stat).toBe('carried figure');
    expect(groups[0].findings).toEqual([catalog[0], catalog[1]]);
  });

  it('recomputes the groups over the findings a filter keeps', () => {
    const catalog = [findingWithMagnitude('spill', 1, 3000), findingWithMagnitude('spill', 2, 2000)];
    const state = installInterpretation(catalog, APP_MODEL);
    expect(useFixTheseFirstData(catalog, [], APP_MODEL.stages, state).groups[0].stat).toBe('×2 · 5.0s recoverable');
    const filtered = useFixTheseFirstData([catalog[1]], [], APP_MODEL.stages, state);
    expect(filtered.eligible).toEqual([catalog[1]]);
    expect(filtered.groups).toHaveLength(1);
    expect(filtered.groups[0].findings).toEqual([catalog[1]]);
    expect(filtered.groups[0].stat).toBe('×1 · 2.0s recoverable');
  });
});

describe('duplicatePlanSubtree identity across a cross-execution rollup', () => {
  // Regression: two unrelated SQL executions can share the same
  // rootName+groupIndex pair (groupIndex resets per execution), and the rollup
  // groups by `type` alone, so both land in one group and must stay disambiguated.
  it('renders distinct identity labels for two same-rootName/groupIndex findings from different SQL executions', () => {
    const findingA: Finding = {
      id: 'f5d7a7a7', type: 'duplicatePlanSubtree', executionId: 64, impactBand: 'critical',
      rootName: 'Filter', groupIndex: 1, stageIds: [91, 96, 97],
      recommendation: 'Consider caching/persisting the shared computation.',
      impactEstimate: { basis: 'contended', wallClock: { low: 141262, high: 141296 }, estimateMethod: 'measured' },
    };
    const findingB: Finding = {
      id: '5660db92', type: 'duplicatePlanSubtree', executionId: 65, impactBand: 'warning',
      rootName: 'Filter', groupIndex: 1, stageIds: [103],
      recommendation: 'Consider caching/persisting the shared computation.',
      impactEstimate: { basis: 'serial', wallClock: { low: 35920, high: 35920 }, estimateMethod: 'measured' },
    };
    const group = groupOf([findingA, findingB]);
    expect(group.findings).toHaveLength(2);

    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <TypeGroupRow group={group} allFindings={[findingA, findingB]} expanded onToggle={() => {}} onRoute={() => {}} />
          </TableBody>
        </Table>
      </StageDetailProvider>,
    );

    // Disambiguated by SQL execution id, so neither row reads a bare "Filter #2".
    expect(screen.getByText('Filter #2 (SQL 64)')).toBeInTheDocument();
    expect(screen.getByText('Filter #2 (SQL 65)')).toBeInTheDocument();
    expect(screen.queryByText('Filter #2')).not.toBeInTheDocument();
  });
});

describe('isEligible exclusions (incompleteRun / memoryUtilization dataUnavailable)', () => {
  it('excludes incompleteRun findings even though the type is routeable in REGISTRY', () => {
    const incompleteRun: Finding = {
      type: 'incompleteRun', impactBand: 'warning',
      recommendation: 'Re-run with a complete event log.',
    };
    const spill = findingWithMagnitude('spill', 1, 5000, 'critical');
    const { eligible } = boardData([incompleteRun, spill]);
    expect(eligible).toEqual([spill]);
  });

  it('excludes a memoryUtilization memoryBand finding that reports dataUnavailable', () => {
    const dataUnavailable: Finding = {
      type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
      impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
      recommendation: 'Per-executor memory usage requires spark.eventLog.logStageExecutorMetrics=true: not enabled for this run.',
    };
    const spill = findingWithMagnitude('spill', 1, 5000, 'critical');
    const { eligible } = boardData([dataUnavailable, spill]);
    expect(eligible).toEqual([spill]);
  });

  it('keeps a memoryUtilization memoryBand finding when the underlying data was actually available', () => {
    const heapNearCapacity: Finding = {
      type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity', stageId: null, executorId: '1',
      impactBand: 'warning', metric: 'heapUsedRatio', value: 97,
      recommendation: 'Executor 1 peaked at 97% of allocated heap: memory may be too small; raise spark.executor.memory to avoid OOM/spill.',
    };
    const { eligible } = boardData([heapNearCapacity]);
    expect(eligible).toEqual([heapNearCapacity]);
  });

  it('keeps a memoryUtilization finding of a different variant (idleCores), which never carries dataUnavailable at all', () => {
    const idleCores: Finding = {
      type: 'memoryUtilization', variant: 'idleCores', stageId: null,
      impactBand: 'warning', metric: 'idleCoreRate', value: 80,
      recommendation: '80% of allocated core-time ran no task: reduce cluster size or enable dynamic allocation.',
    };
    const { eligible } = boardData([idleCores]);
    expect(eligible).toEqual([idleCores]);
  });
});

describe('TypeGroupRow generic description', () => {
  it("shows the type-level generic sentence, not the highest-impact member's own instance-specific recommendation", () => {
    const findings = [
      findingWithMagnitude('gc', 1, 5000, 'warning'),
      findingWithMagnitude('gc', 2, 9000, 'critical'),
    ];
    const group = groupOf(findings);

    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <TypeGroupRow group={group} allFindings={findings} expanded={false} onToggle={() => {}} onRoute={() => {}} />
          </TableBody>
        </Table>
      </StageDetailProvider>,
    );

    expect(
      screen.getByText('Reduce object creation, use primitive types, avoid UDFs, or increase executor memory to cut GC time.'),
    ).toBeInTheDocument();
    // The best member (Stage 2, higher wallClock) is whose action label/badge the row still uses,
    // but its own recommendation text must not leak through as the group's description.
    expect(screen.queryByText('Fix gc in Stage 2.')).not.toBeInTheDocument();
  });

  it('omits the muted description line entirely for a finding type with no generic sentence, rather than falling back to instance text', () => {
    const findings: Finding[] = [
      {
        type: 'notARealDetector', impactBand: 'warning', stageId: 1,
        recommendation: 'Fix notARealDetector in Stage 1.',
        impactEstimate: { basis: 'serial', wallClock: { low: 1000, high: 1000 }, estimateMethod: 'modeled' },
      },
      {
        type: 'notARealDetector', impactBand: 'critical', stageId: 2,
        recommendation: 'Fix notARealDetector in Stage 2.',
        impactEstimate: { basis: 'serial', wallClock: { low: 2000, high: 2000 }, estimateMethod: 'modeled' },
      },
    ];
    const group = groupOf(findings);

    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <TypeGroupRow group={group} allFindings={findings} expanded={false} onToggle={() => {}} onRoute={() => {}} />
          </TableBody>
        </Table>
      </StageDetailProvider>,
    );

    expect(screen.queryByText('Fix notARealDetector in Stage 1.')).not.toBeInTheDocument();
    expect(screen.queryByText('Fix notARealDetector in Stage 2.')).not.toBeInTheDocument();
  });
});

describe('TypeGroupRow docs link', () => {
  function configFinding(docAnchor: string, property: string): Finding {
    return { type: 'configAudit', impactBand: 'warning', stageId: null, property, docAnchor, recommendation: `Fix ${property}.` };
  }

  function renderGroup(findings: Finding[]) {
    const group = groupOf(findings);
    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <TypeGroupRow group={group} allFindings={findings} expanded={false} onToggle={() => {}} onRoute={() => {}} />
          </TableBody>
        </Table>
      </StageDetailProvider>,
    );
  }

  it('links a configAudit group pill to the sub-check section its findings share', () => {
    renderGroup([
      configFinding('#config-autoscale-bounds', 'spark.dynamicAllocation.minExecutors'),
      configFinding('#config-autoscale-bounds', 'spark.dynamicAllocation.maxExecutors'),
    ]);
    expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/tuning-reference/config.html#config-autoscale-bounds');
  });

  it('falls back to the guide entry when the group spans several sub-checks', () => {
    renderGroup([
      configFinding('#config-autoscale-bounds', 'spark.dynamicAllocation.maxExecutors'),
      configFinding('#config-serializer', 'spark.serializer'),
    ]);
    expect(screen.getByRole('link', { name: 'CFG' })).toHaveAttribute('href', 'docs/user-guide/understanding-findings.html#cfg');
  });
});

describe('TypeGroupRow pagination', () => {
  it('paginates an expanded group of more than PAGE_SIZE (10) findings, 10-per-page, with Previous/Next controls', async () => {
    const user = userEvent.setup();
    const findings = Array.from({ length: 11 }, (_, i) => findingWithMagnitude('spill', i + 1, 1000 + i * 100, 'warning'));
    const group = groupOf(findings);
    expect(group.findings).toHaveLength(11);

    render(
      <StageDetailProvider>
        <Table>
          <TableBody>
            <TypeGroupRow group={group} allFindings={findings} expanded onToggle={() => {}} onRoute={() => {}} />
          </TableBody>
        </Table>
      </StageDetailProvider>,
    );

    expect(screen.getAllByTestId('fix-these-first-row')).toHaveLength(10);
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(screen.getAllByTestId('fix-these-first-row')).toHaveLength(1);
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
  });
});

describe('TypeGroupRow expand/collapse', () => {
  // TypeGroupRow itself is controlled (expanded/onToggle come from the parent),
  // so this harness owns the toggled state to exercise a real click round trip
  // rather than only asserting onToggle was called.
  function ControlledGroupRow({ group, allFindings }: { group: BoardGroup; allFindings: Finding[] }) {
    const [expanded, setExpanded] = useState(false);
    return (
      <Table>
        <TableBody>
          <TypeGroupRow group={group} allFindings={allFindings} expanded={expanded} onToggle={() => setExpanded((e) => !e)} onRoute={() => {}} />
        </TableBody>
      </Table>
    );
  }

  it('defaults to collapsed, then expands/collapses on click: chevron swaps, aria-expanded toggles, rows only render when expanded', async () => {
    const user = userEvent.setup();
    const findings = [
      findingWithMagnitude('spill', 1, 5000, 'warning'),
      findingWithMagnitude('spill', 2, 3000, 'warning'),
    ];
    const group = groupOf(findings);
    expect(group.findings).toHaveLength(2);

    const { container } = render(
      <StageDetailProvider>
        <ControlledGroupRow group={group} allFindings={findings} />
      </StageDetailProvider>,
    );

    const groupRow = screen.getByTestId('fix-these-first-group-row');
    const toggle = within(groupRow).getByRole('button');

    // Collapsed by default: no member rows, chevron pointing down.
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('fix-these-first-row')).toHaveLength(0);
    expect(container.querySelector('.lucide-chevron-down')).toBeInTheDocument();
    expect(container.querySelector('.lucide-chevron-up')).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('fix-these-first-row')).toHaveLength(2);
    expect(container.querySelector('.lucide-chevron-up')).toBeInTheDocument();
    expect(container.querySelector('.lucide-chevron-down')).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByTestId('fix-these-first-row')).toHaveLength(0);
    expect(container.querySelector('.lucide-chevron-down')).toBeInTheDocument();
    expect(container.querySelector('.lucide-chevron-up')).not.toBeInTheDocument();
  });
});

describe('impactFigure', () => {
  const withRawWaste = (value: number): Finding => ({
    type: 'jobFailureRate', stageId: null, impactBand: 'critical', recommendation: 'Inspect the failed jobs.',
    impactEstimate: { basis: 'resourceOnly', rawWaste: { value, unit: 'coreHours' }, estimateMethod: 'modeled' },
  } as Finding);

  it('prints a raw resource figure that has a real value', () => {
    expect(impactFigure(withRawWaste(1.25))).toBe('1.3 core-h');
  });

  it('drops a raw figure that rounds to zero instead of printing "0.0 core-h"', () => {
    expect(impactFigure(withRawWaste(0.04))).toBeNull();
  });
});
