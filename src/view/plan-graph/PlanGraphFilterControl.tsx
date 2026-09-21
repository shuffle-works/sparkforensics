import { Chip } from '@/view/ImpactBadge';
import { PlanGraphRadioControl } from '@/view/plan-graph/PlanGraphRadioControl';
import type { PlanGraphFilterMode } from '@sparkforensics/core/types.ts';

const OPTIONS: Array<{ value: PlanGraphFilterMode; label: string; description: string }> = [
  {
    value: 'io',
    label: 'I/O only',
    description: 'Show only scan and exchange nodes, where the plan reads or shuffles/broadcasts data.',
  },
  {
    value: 'basic',
    label: 'Basic',
    description: 'Add join, aggregate, sort, and filter nodes to I/O; hide pass-through and boilerplate operators like Project or WholeStageCodegen.',
  },
  {
    value: 'advanced',
    label: 'Advanced',
    description: 'Show every operator, including the pass-through and boilerplate nodes the other two modes hide.',
  },
];

export interface PlanGraphFilterControlProps {
  mode: PlanGraphFilterMode;
  onChange: (mode: PlanGraphFilterMode) => void;
  hiddenCount: number;
}

export function PlanGraphFilterControl({ mode, onChange, hiddenCount }: PlanGraphFilterControlProps) {
  return (
    <PlanGraphRadioControl
      ariaLabel="Node filter"
      name="plan-graph-filter"
      options={OPTIONS}
      value={mode}
      onChange={onChange}
      trailingContent={hiddenCount > 0 ? <Chip label={`${hiddenCount} nodes hidden`} impactBand="info" /> : null}
    />
  );
}
