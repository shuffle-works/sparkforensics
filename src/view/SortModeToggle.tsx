import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { SortMode } from '@/view/impact-sort';

/** Flips a widget's list between impact order (the default: highest
 * potential savings first) and stage order (ascending stage number).
 * Advanced-only: re-ordering by stage is a power-user affordance, and
 * `useSortMode`'s `orderBy` already forces impact order at Basic regardless
 * of a caller's raw `sortMode` state, so hiding the control here can't leave
 * a widget stuck showing stage order with no way back. A two-segment control
 * with both options always visible, so the active mode is unambiguous,
 * unlike a single button whose label names the mode a click would switch
 * *to*, which leaves the current mode implicit. `stageLabel` lets a caller
 * rename the stage segment (e.g. a multi-stage finding might want something
 * other than the generic default), but every current caller is happy with
 * it. */
export function SortModeToggle({
  mode,
  onChange,
  stageLabel = 'Stage',
}: {
  mode: SortMode;
  onChange: (mode: SortMode) => void;
  stageLabel?: string;
}) {
  return (
    <AdvancedOnly>
      <ToggleGroup
        aria-label="Sort order"
        spacing={0}
        value={[mode]}
        onValueChange={(next) => {
          const value = next[0] as SortMode | undefined;
          // Ignore the deselect-to-empty click on the already-active segment:
          // one of the two modes must always stay selected.
          if (value) onChange(value);
        }}
      >
        <ToggleGroupItem value="impact" variant="outline" size="sm" className="tap-target-comfortable tap-target-comfortable--sm">
          Impact
        </ToggleGroupItem>
        <ToggleGroupItem value="stage" variant="outline" size="sm" className="tap-target-comfortable tap-target-comfortable--sm">
          {stageLabel}
        </ToggleGroupItem>
      </ToggleGroup>
    </AdvancedOnly>
  );
}
