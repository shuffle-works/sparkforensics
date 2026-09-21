import { SearchX } from 'lucide-react';
import { EmptyState } from '@/view/EmptyState';
import { useFindingFilter } from '@/view/FindingFilterContext';

/** The catalog has findings but the active filter matches none. Offers an
 * inline escape hatch back to the full board. */
export function NoMatchBanner() {
  const { clearAll } = useFindingFilter();
  return (
    <EmptyState
      icon={SearchX}
      title="No findings match the active filters"
      description="Adjust or clear the filters to see findings."
      action={
        <button type="button" onClick={clearAll} className="cursor-pointer text-sm underline">
          Clear all filters
        </button>
      }
    />
  );
}
