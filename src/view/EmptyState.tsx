import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

const TONE_STYLES = {
  /** Nothing to fix, a positive result (e.g. no findings, no spill). */
  clean: { box: 'border-clean/40 bg-clean/10', icon: 'text-clean', title: 'text-clean' },
  /** No data to show, neither good nor bad (e.g. an empty stage list). */
  neutral: { box: 'border-border/60 bg-muted/40', icon: 'text-muted-foreground', title: 'text-foreground' },
} as const;

/** The one shared empty-state shell for the dashboard: an icon, a title, an
 * optional detail line, and an optional trailing action, replacing what used
 * to be a different hand-rolled bare `<p>` per widget with inconsistent
 * wording and no visual weight. Fits directly inside `WidgetCard`'s
 * `CardContent` as ordinary children. */
export function EmptyState({
  icon: Icon,
  tone = 'neutral',
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  tone?: keyof typeof TONE_STYLES;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  const styles = TONE_STYLES[tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-xl border p-4', styles.box, className)}>
      <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', styles.icon)} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium', styles.title)}>{title}</p>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}
