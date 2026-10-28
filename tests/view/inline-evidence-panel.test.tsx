// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { coreFindingGenericRecommendation } from '@sparkforensics/core/finding-generic-recommendation.ts';
import { worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { Finding, FindingOf } from '@sparkforensics/core/types.ts';

import { ImpactEstimate } from '@/view/ImpactEstimate';
import { InlineEvidence } from '@/view/InlineEvidence';
import { TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { installInterpretation } from './_shared/interpretation';
import { allRowsPanel } from './_shared/evidence-panel';
import { testFinding } from './_shared/finding';

const estimate = { basis: 'serial', wallClock: { low: 1200, high: 1200 }, estimateMethod: 'measured', rawWaste: { value: 1200, unit: 'ms' } } as const;

function stated(impactBand: Finding['impactBand'] = 'critical') {
  return testFinding({ type: 'spill', stageId: 1, impactBand, id: 'spill-1', impactEstimate: estimate });
}
function other() {
  return testFinding({ type: 'spill', stageId: 2, impactBand: 'critical', id: 'spill-2', impactEstimate: estimate });
}

function PanelWidget({ findings }: { findings?: Finding[] }) {
  const impactBand = worstImpactBand(findings ?? []) ?? 'info';
  return (
    <WidgetCard title="Spill" impactBand={impactBand} fixFor={findings ?? []} badges={<TagBadge type="spill" impactBand={impactBand} />}>
      {(findings ?? []).map((finding) => <ImpactEstimate key={finding.id} finding={finding} />)}
      <p>panel body</p>
    </WidgetCard>
  );
}

function renderPanel(findings: Finding[], statedFindings: Finding[]) {
  installInterpretation(findings);
  const widget = { component: () => <PanelWidget findings={findings} />, widgetId: 'spill', index: 0, findings, impactBand: 'critical' };
  return render(<InlineEvidence widget={widget as never} widgetProps={{ appModel: undefined as never, catalog: findings, getTaskData: undefined as never }} stated={statedFindings} panel={allRowsPanel('spill', findings as FindingOf<'spill'>[])} />);
}

describe('in-place evidence panel', () => {
  it('gives the widget only the findings of its scope', () => {
    const [first, second] = [stated(), other()];
    installInterpretation([first, second]);
    const Widget = ({ catalog }: { catalog: Finding[] }) => <p>{catalog.map((finding) => finding.id).join(',')}</p>;
    const widget = { component: Widget, widgetId: 'spill', index: 0, findings: [first, second], impactBand: 'critical' };
    render(<InlineEvidence widget={widget as never} widgetProps={{ appModel: undefined as never, catalog: [first, second], getTaskData: undefined as never }} panel={allRowsPanel('spill', [first])} />);
    expect(screen.getByText('spill-1')).toBeInTheDocument();
  });

  it('renders the widget as an open, flat panel with the card heading and no disclosure control', () => {
    renderPanel([stated()], []);
    expect(screen.getByRole('heading', { name: 'Spill', level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Spill' })).not.toBeInTheDocument();
    expect(screen.getByText('panel body')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Spill' }).closest('section')).toHaveClass('border-l-[3px]', 'border-critical');
  });

  it('leaves out the tag badge and the generic fix the line above already carries', () => {
    const finding = stated();
    renderPanel([finding], []);
    expect(screen.queryByText('SPILL')).not.toBeInTheDocument();
    expect(coreFindingGenericRecommendation(finding)).toBeTruthy();
    expect(screen.queryByText(coreFindingGenericRecommendation(finding)!)).not.toBeInTheDocument();
  });

  it("draws the left rule in the stated finding's band, not the widget's worst band", () => {
    const lead = stated('warning');
    renderPanel([lead, other()], [lead]);
    const panel = screen.getByRole('heading', { name: 'Spill' }).closest('section');
    expect(panel).toHaveClass('border-warning');
    expect(panel).not.toHaveClass('border-critical');
  });

  it("falls back to the widget's band when the line above states no finding", () => {
    renderPanel([stated('warning'), other()], []);
    expect(screen.getByRole('heading', { name: 'Spill' }).closest('section')).toHaveClass('border-critical');
  });

  it('makes the heading the route focus target', () => {
    renderPanel([stated()], []);
    expect(screen.getByRole('heading', { name: 'Spill' })).toHaveAttribute('tabindex', '-1');
  });

  it('drops the savings figure only for the finding the line above states', () => {
    const findings = [stated(), other()];
    renderPanel(findings, [findings[0]]);
    expect(screen.getAllByText('Potential savings:')).toHaveLength(1);
  });

  it('keeps every figure when the line above states no finding in the panel', () => {
    renderPanel([stated(), other()], []);
    expect(screen.getAllByText('Potential savings:')).toHaveLength(2);
  });
});

describe('outside an evidence panel', () => {
  it('a widget card stays a collapsible card with its tag badge', () => {
    const finding = stated();
    installInterpretation([finding]);
    render(<PanelWidget findings={[finding]} />);
    expect(screen.getByRole('button', { name: 'Spill' })).toBeInTheDocument();
    expect(screen.getByText('SPILL')).toBeInTheDocument();
    expect(screen.getByText(coreFindingGenericRecommendation(finding)!)).toBeInTheDocument();
    expect(screen.getByText('Potential savings:')).toBeInTheDocument();
  });
});
