import { useMemo, useState } from 'react';
import { ChevronDown, ListFilter, X } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';
import { typeTag } from '@sparkforensics/core/format-utils.ts';
import type { ImpactBand } from '@sparkforensics/core/types.ts';
import { ImpactDot } from './ImpactBadge';
import { isEmptySelection, type FilterOptions } from './finding-filter';
import { useFindingFilter } from './FindingFilterContext';

// Selected pills tint to their impact color; the dot carries the color when
// unselected. Keeps the fixed impact palette single-sourced with ImpactDot.
const IMPACT_PILL: Record<ImpactBand, string> = {
  critical: 'aria-pressed:bg-critical/10 aria-pressed:text-critical',
  warning: 'aria-pressed:bg-warning/10 aria-pressed:text-warning',
  info: 'aria-pressed:bg-info/10 aria-pressed:text-info',
};

/** ToggleGroup fires the whole next value array; recover the single changed
 * value and route it through the existing per-value context toggle so the
 * store/URL codec stays the single source of truth. */
function toggleChanged<T extends string>(next: readonly T[], current: Set<T>, toggle: (v: T) => void) {
  const nextSet = new Set(next);
  for (const v of nextSet) if (!current.has(v)) toggle(v);
  for (const v of current) if (!nextSet.has(v)) toggle(v);
}

/** A dropdown holding checkbox items for one filter dimension. The trigger
 * shows the dimension name and, when constrained, the active count. */
function DimensionMenu({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'gap-1.5')}
        aria-label={`Filter by ${label.toLowerCase()}`}
      >
        {label}
        {count > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-xs font-medium text-primary-foreground">{count}</span>
        )}
        <ChevronDown aria-hidden="true" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-72 w-56 overflow-y-auto">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Board-wide finding filter toolbar. Impact is a row of color-coded toggle
 * pills; Type and Stage are on-demand dropdowns (Stage searchable, since a run
 * can have dozens of stages). Active constraints stay visible as removable
 * chips even when the menus are closed. Renders nothing when the catalog offers
 * no options.
 */
export function FindingFilterBar({ options, resultCount }: { options: FilterOptions; resultCount: number }) {
  const { selection, toggleImpactBand, toggleType, toggleStage, clearAll } = useFindingFilter();
  const [stageQuery, setStageQuery] = useState('');
  const [typeQuery, setTypeQuery] = useState('');

  const visibleStages = useMemo(() => {
    const q = stageQuery.trim();
    if (!q) return options.stages;
    return options.stages.filter((s) => String(s).includes(q));
  }, [options.stages, stageQuery]);

  // Matches either the tag shown in the menu ("SKEW") or the full type name
  // ("skew"), since a user might reach for either.
  const visibleTypes = useMemo(() => {
    const q = typeQuery.trim().toLowerCase();
    if (!q) return options.types;
    return options.types.filter((v) => v.toLowerCase().includes(q) || typeTag(v).toLowerCase().includes(q));
  }, [options.types, typeQuery]);

  if (options.impactBands.length === 0 && options.types.length === 0 && options.stages.length === 0) {
    return null;
  }
  const active = !isEmptySelection(selection);

  const chips: { key: string; label: string; onRemove: () => void }[] = [
    ...[...selection.impactBands].map((v) => ({
      key: `impact-${v}`,
      label: `impact ${v}`,
      onRemove: () => toggleImpactBand(v as ImpactBand),
    })),
    ...[...selection.types].map((v) => ({
      key: `type-${v}`,
      label: `type ${v}`,
      onRemove: () => toggleType(v),
    })),
    ...[...selection.stages].map((v) => ({
      key: `stage-${v}`,
      label: `stage ${v}`,
      onRemove: () => toggleStage(v),
    })),
  ];

  return (
    <section
      aria-label="Filter findings"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/60 p-2"
    >
      {/* Subtle title + one-line explanation (tooltip) so the row reads as a
          filter, not a stray set of controls. Spells out "whole dashboard"
          since the row visually sits above one section but scopes all of
          FixTheseFirst, Alerts, and ReferenceSection (see Dashboard.tsx). */}
      <span
        title="Narrow the whole dashboard to findings matching the chosen impact bands, types, or stages"
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
      >
        <ListFilter aria-hidden="true" className="size-3.5" />
        Filter findings
      </span>
      {/* Visible, always-on result count (not just sr-only) so sighted users
          get a count too. Doubles as the aria-live region so screen readers
          still get the update. */}
      <span role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {active
          ? `${resultCount} finding${resultCount === 1 ? '' : 's'} match${resultCount === 1 ? 'es' : ''} the active filters`
          : `Showing all ${resultCount} finding${resultCount === 1 ? '' : 's'}`}
      </span>
      <Separator orientation="vertical" className="h-6" />

      {options.impactBands.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Impact</span>
          <ToggleGroup
            multiple
            aria-label="Filter by impact"
            value={[...selection.impactBands]}
            onValueChange={(next) => toggleChanged(next as ImpactBand[], selection.impactBands, toggleImpactBand)}
          >
            {options.impactBands.map((band) => (
              <ToggleGroupItem
                key={band}
                value={band}
                variant="outline"
                size="sm"
                aria-label={`Filter by impact: ${band}`}
                className={cn('tap-target-comfortable gap-1.5', IMPACT_PILL[band])}
              >
                <ImpactDot impactBand={band} />
                {band}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      )}

      {options.types.length > 0 && (
        <>
          <Separator orientation="vertical" className="h-6" />
          <DimensionMenu label="Type" count={selection.types.size}>
            {/* Stop keydown from reaching the menu's typeahead so typing filters
                the list instead of jumping between items (same fix as Stage's
                search box below). */}
            <div className="p-1">
              <Input
                type="text"
                value={typeQuery}
                onChange={(e) => setTypeQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search type…"
                aria-label="Search types"
                autoComplete="off"
                className="h-8"
              />
            </div>
            {visibleTypes.map((v) => (
              <DropdownMenuCheckboxItem
                key={v}
                checked={selection.types.has(v)}
                onCheckedChange={() => toggleType(v)}
                aria-label={`Filter by type: ${v}`}
              >
                {/* Pin the tag's text color with `!`: the menu row forces
                    `text-accent-foreground` onto every descendant when
                    highlighted, which would make this bg-muted pill turn
                    invisible (white-on-white / black-on-black). */}
                <span className="rounded bg-muted px-1 text-xs font-medium text-foreground!">{typeTag(v)}</span> {v}
              </DropdownMenuCheckboxItem>
            ))}
            {visibleTypes.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching type</p>
            )}
          </DimensionMenu>
        </>
      )}

      {options.stages.length > 0 && (
        <>
          <Separator orientation="vertical" className="h-6" />
          <DimensionMenu label="Stage" count={selection.stages.size}>
            {/* Stop keydown from reaching the menu's typeahead so typing filters
                the list instead of jumping between items. */}
            <div className="p-1">
              <Input
                type="text"
                value={stageQuery}
                onChange={(e) => setStageQuery(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
                placeholder="Search stage id…"
                aria-label="Search stages"
                autoComplete="off"
                className="h-8"
              />
            </div>
            {visibleStages.map((v) => (
              <DropdownMenuCheckboxItem
                key={v}
                checked={selection.stages.has(v)}
                onCheckedChange={() => toggleStage(v)}
                aria-label={`Filter by stage: ${v}`}
              >
                Stage {v}
              </DropdownMenuCheckboxItem>
            ))}
            {visibleStages.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No matching stage</p>
            )}
          </DimensionMenu>
        </>
      )}

      {active && (
        <>
          <Separator orientation="vertical" className="h-6" />
          <div className="flex flex-wrap items-center gap-1.5">
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onRemove}
                aria-label={`Remove filter: ${chip.label}`}
                className="tap-target-comfortable inline-flex cursor-pointer items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs hover:bg-muted/70"
              >
                {chip.label} <X aria-hidden="true" className="size-3" />
              </button>
            ))}
            <button type="button" onClick={clearAll} className="tap-target-comfortable cursor-pointer text-xs underline">
              Clear all filters
            </button>
          </div>
        </>
      )}
    </section>
  );
}
