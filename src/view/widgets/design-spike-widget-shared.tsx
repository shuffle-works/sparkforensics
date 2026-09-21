import { AdvancedOnly } from '@/view/AdvancedOnly';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { DESIGN_SPIKE_DISCLAIMER } from '@/view/design-spike-disclaimer';

/** Formats a core-hour figure the way every design-spike compute-estimate
 * widget does: rounded to two decimals, with a `core-h` suffix. */
export const formatCoreHours = (h: number): string => `${Math.round(h * 100) / 100} core-h`;

/** Badge slot for a design-spike/unvalidated widget: the standard
 * low-confidence marker carrying `DESIGN_SPIKE_DISCLAIMER`, hidden outside
 * Advanced density. Pass via `WidgetCard`'s `statusBadge` prop (not
 * `badges`) so it only renders once the card is expanded. Shared by
 * WastedCoreHours and EfficiencyModel, the two core-hour compute-estimate
 * widgets that badge themselves identically. */
export function DesignSpikeConfidenceBadge() {
  return (
    <AdvancedOnly>
      <RowStatusCluster
        confidence="low"
        validationRequired={DESIGN_SPIKE_DISCLAIMER}
      />
    </AdvancedOnly>
  );
}
