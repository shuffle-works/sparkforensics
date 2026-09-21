import { cva } from 'class-variance-authority';
import { FileText } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { docsUrl } from '@sparkforensics/core/docs-config.ts';
import { findingGuideUrl } from '@sparkforensics/core/docs-site-config.ts';
import { cn } from '@/lib/utils';
import type { ImpactBand } from '@sparkforensics/core/types.ts';
import { typeTag } from '@sparkforensics/core/format-utils.ts';
import { useOptionalDocs } from '@/view/DocsContext';
import { docAnchorForType, TAG_HELP } from '@/view/finding-tag-help';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { useWidgetDensity } from '@/store/store';

/** Single source of truth for the impact-band → Tailwind color-token
 * association. Widgets that flag their own instrumentation (borders, text,
 * fill bars) outside the dot+badge vocabulary (e.g. Scorecard's KPI tiles)
 * should index these instead of keeping a second, locally-duplicated class
 * map for the same critical/warning/info palette. */
export const IMPACT_BG_CLASS: Record<ImpactBand, string> = {
  critical: 'bg-critical',
  warning: 'bg-warning',
  info: 'bg-info',
};

export const IMPACT_TEXT_CLASS: Record<ImpactBand, string> = {
  critical: 'text-critical',
  warning: 'text-warning',
  info: 'text-info',
};

export const IMPACT_BORDER_CLASS: Record<ImpactBand, string> = {
  critical: 'border-critical',
  warning: 'border-warning',
  info: 'border-info',
};

const dotVariants = cva('inline-block size-2 shrink-0 rounded-full', {
  variants: {
    impactBand: {
      ...IMPACT_BG_CLASS,
      // Additive 4th tier for a component-local "inert/not applicable" case
      // (e.g. EvidenceAvailability's three inert evidence states): the core
      // `ImpactBand` type stays 3-valued everywhere else in the codebase.
      muted: 'bg-muted-foreground',
    },
  },
  defaultVariants: { impactBand: 'info' },
});

const severityBadgeVariants = cva('gap-1.5 border-transparent', {
  variants: {
    impactBand: {
      critical: 'bg-critical/10 text-critical',
      warning: 'bg-warning/10 text-warning',
      info: 'bg-info/10 text-info',
    },
  },
  defaultVariants: { impactBand: 'info' },
});

export interface ImpactDotProps {
  /** Accepts the shared 3-value `ImpactBand` plus a component-local `'muted'`
   * tier for callers (e.g. EvidenceAvailability) that need an inert/not-applicable
   * dot color with no equivalent in the core `Finding['impactBand']` vocabulary. */
  impactBand: ImpactBand | 'muted';
  className?: string;
}

/** Colored round dot carrying impact: the fixed "colored dot" half of the
 * problem-flagging contract (AGENTS.md). Purely decorative; the tag text
 * next to it is what's announced to assistive tech. */
export function ImpactDot({ impactBand, className }: ImpactDotProps) {
  return <span aria-hidden="true" className={cn(dotVariants({ impactBand }), className)} />;
}

export interface TagBadgeProps {
  type: string;
  impactBand: ImpactBand;
  className?: string;
  /** FixTheseFirst's row buttons (`FindingRow`/`TypeGroupRow`) and
   * StageTable's stage-tag pill each nest TagBadge inside a <button> that
   * already carries its own, more specific `title` (e.g. "Investigate X in
   * Stage Y"); an <a> inside a <button> is invalid HTML and would fight the
   * existing click handler, and TagBadge's own TAG_HELP title would shadow
   * the button's tooltip over its whole hoverable area. Set at those call
   * sites to suppress both the docs link and the title, keeping the plain
   * rendering (no TAG_HELP tooltip, no link) it has today. */
  plainBadge?: boolean;
}

/** Impact dot + ALL-CAPS tag (via `typeTag`): the fixed board vocabulary
 * (SKEW/SHFL/SPILL/... ). Never hand-type the tag text; it always comes from
 * `typeTag(type)` so the vocabulary stays single-sourced.
 *
 * Also carries the tag's plain-language help as a `title` tooltip, and renders
 * as a real link into the docs panel when `type` resolves to a single, known
 * documentation anchor (`docAnchorForType`), with the same modifier-key/
 * non-primary-button passthrough as `DocsLink`. Outside a `DocsProvider`
 * (most widget unit tests render bare) the link still renders with a real
 * `href` but clicking it falls through to native navigation instead of
 * opening the in-app panel.
 *
 * Beside the dot+tag, renders a second icon link at the Advanced density tier
 * into this tag's SparkForensics-specific remediation entry in
 * `docs-site/user-guide/understanding-findings.md` (`findingGuideUrl`). It
 * opens in the same in-app docs panel as the vendor link (same click
 * behavior, same modifier-key/non-primary-button passthrough, same panel);
 * the vendor link documents Spark generically, this one documents what the
 * tag means for a SparkForensics run, so the two stay distinct entry points
 * rather than collapsing into one. `target`/`rel` stay on the `<a>` as the
 * graceful-degradation fallback (modifier-click, no JS, no `DocsProvider`
 * ancestor), exactly like the vendor link. At Basic density the guide link
 * doesn't render (wrapped in `AdvancedOnly`): the dot+tag pill alone is the
 * primary problem-flagging vocabulary a first-time reader scans, and the
 * "go read the reference doc" affordance is Advanced-tier detail.
 *
 * Rendered as two abutting halves that read as one pill: the dot+tag `Badge`
 * (rounded on its left only when the guide link follows, i.e. at Advanced
 * density) and, immediately after it, the guide `<a>` rounded on the right;
 * never one `<a>` nested inside the other, which isn't valid HTML and is
 * exactly what a single pill-wide anchor would require once a second link
 * needs to sit inside it. The guide link is hand-styled rather than built
 * from `Badge` because `Badge`'s own `overflow-hidden` would clip its
 * `tap-target-comfortable` hit-area overlay, which deliberately paints
 * outside the link's visual bounds to reach a touch-friendly size without
 * growing the pill. */
export function TagBadge({ type, impactBand, className, plainBadge }: TagBadgeProps) {
  const docs = useOptionalDocs();
  const density = useWidgetDensity();
  const tag = typeTag(type);
  const help = TAG_HELP[tag];
  const title = plainBadge ? undefined : (help ? `${help.expansion}: ${help.description}` : undefined);
  const anchor = plainBadge ? undefined : docAnchorForType(type);
  const guideLabel = help?.expansion ?? tag;
  const showGuideLink = !plainBadge && density === 'advanced';

  const label = (
    <Badge
      title={title}
      className={cn(severityBadgeVariants({ impactBand }), 'h-6', showGuideLink ? cn('rounded-r-none', className) : className)}
      render={anchor ? (
        <a
          href={docsUrl(anchor)}
          onClick={(e) => {
            if (!docs || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            docs.open(anchor);
          }}
        />
      ) : undefined}
    >
      <ImpactDot impactBand={impactBand} />
      {tag}
    </Badge>
  );

  if (plainBadge) return label;

  const guidePath = findingGuideUrl(type);

  return (
    <span className="inline-flex items-center">
      {label}
      <AdvancedOnly>
        <a
          href={guidePath}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`SparkForensics guide: ${guideLabel}`}
          title={`SparkForensics guide: ${guideLabel}`}
          onClick={(e) => {
            if (!docs || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            docs.openSite(guidePath);
          }}
          className={cn(
            'tap-target-comfortable tap-target-comfortable--sm inline-flex h-6 shrink-0 items-center rounded-r-4xl border border-transparent py-0.5 pr-2 pl-1 text-xs font-medium whitespace-nowrap transition-colors',
            severityBadgeVariants({ impactBand }),
            className,
            'text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          )}
        >
          <FileText aria-hidden="true" className="size-3" />
        </a>
      </AdvancedOnly>
    </span>
  );
}

export interface ChipProps {
  label: string;
  impactBand: ImpactBand;
  title?: string;
  className?: string;
}

/** Mono impact chip for arbitrary (already-formatted) label text (e.g. the
 * spill-classification badges) where the label isn't a `typeTag` lookup. */
export function Chip({ label, impactBand, title, className }: ChipProps) {
  return (
    <Badge title={title} className={cn(severityBadgeVariants({ impactBand }), 'font-mono', className)}>
      {label}
    </Badge>
  );
}
