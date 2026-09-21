import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

/** A section heading that collapses its body behind a chevron: the same
 * disclosure affordance `WidgetCard` uses for its own header (same icon,
 * same trigger styling), instead of the browser's native `<details>`
 * marker. Collapsed by default. */
export function CollapsibleSection({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-2">
      <CollapsibleTrigger
        aria-expanded={String(open) as 'true' | 'false'}
        className="tap-target-comfortable tap-target-comfortable--sm flex cursor-pointer items-center gap-2 bg-transparent text-left"
      >
        <h3 className="font-heading text-sm font-medium">{title}</h3>
        {open ? (
          <ChevronUpIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent keepMounted>{children}</CollapsibleContent>
    </Collapsible>
  );
}
