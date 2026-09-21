import { Fragment, type ReactNode } from 'react';
import { CollapsibleSection } from '@/view/CollapsibleSection';

export type Row = [string, ReactNode] | null | false | undefined;

/** Definition-list-style metric section: label/value grid used for stage
 * metadata (Overview, Tasks, I/O, ...) and, when nested without a `title`, for
 * a single structured record inside a larger disclosure (see PlanView.tsx's
 * per-node "full detail" panel and Summary tab). Renders nothing when it has
 * neither rows nor extra content. `collapsible` (only meaningful with a
 * `title`) renders it behind `CollapsibleSection`'s chevron disclosure
 * instead of a plain heading, collapsed by default unless `defaultOpen`. */
export function Section({
  title,
  rows,
  children,
  collapsible = false,
  defaultOpen = false,
}: {
  title?: string;
  rows: Row[];
  children?: ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
}) {
  const items = rows.filter((r): r is [string, ReactNode] => Boolean(r));
  if (items.length === 0 && !children) return null;

  const grid = (
    <div className="grid min-w-0 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      {items.map(([label, value], i) => (
        <Fragment key={i}>
          <span className="text-muted-foreground">{label}</span>
          <span className="break-words">{value}</span>
        </Fragment>
      ))}
    </div>
  );

  if (collapsible && title) {
    return (
      <CollapsibleSection title={title} defaultOpen={defaultOpen}>
        <div className="space-y-2">
          {grid}
          {children}
        </div>
      </CollapsibleSection>
    );
  }

  return (
    <section className="space-y-2">
      {title ? <h3 className="font-heading text-sm font-medium">{title}</h3> : null}
      {grid}
      {children}
    </section>
  );
}
