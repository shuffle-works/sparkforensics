import { PlanGraphRadioControl } from '@/view/plan-graph/PlanGraphRadioControl';
import type { PlanGraphDurationMode } from '@sparkforensics/core/types.ts';

const OPTIONS: Array<{ value: PlanGraphDurationMode; label: string; description: string }> = [
  {
    value: 'exclusive',
    label: 'Node only',
    description: "Each node's share reflects time spent in that operator alone, excluding its descendants.",
  },
  {
    value: 'inclusive',
    label: 'Node + descendants',
    description: "Each node's share adds in every descendant operator's time, so an ancestor's bar reflects its whole subtree.",
  },
];

export interface PlanGraphDurationModeControlProps {
  mode: PlanGraphDurationMode;
  onChange: (mode: PlanGraphDurationMode) => void;
}

export function PlanGraphDurationModeControl({ mode, onChange }: PlanGraphDurationModeControlProps) {
  return (
    <PlanGraphRadioControl
      ariaLabel="Duration heat bar scope"
      name="plan-graph-duration-mode"
      options={OPTIONS}
      value={mode}
      onChange={onChange}
    />
  );
}
