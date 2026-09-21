import { CircleCheckIcon } from 'lucide-react';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { TableCell, TableRow } from '@/components/ui/table';
import { typeTag } from '@sparkforensics/core/format-utils.ts';

export interface CleanCheckRowProps {
  type: string;
  label: string;
  thresholdSummary: string;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : text[0].toUpperCase() + text.slice(1);
}

/** One row of the "Clean checks" table: a green tag (the active grid's
 * ALL-CAPS `typeTag` vocabulary, colored `clean` instead of an impact band) so
 * the collapsed disclosure reads the same shorthand as the active findings. */
export function CleanCheckRow({ type, label, thresholdSummary }: CleanCheckRowProps) {
  return (
    <TableRow data-testid="clean-check-row" data-clean-check-type={type}>
      <TableCell className="w-px">
        <span className="inline-flex h-6 items-center gap-1 rounded-full bg-clean/10 px-2 font-mono text-xs font-medium whitespace-nowrap text-clean">
          <CircleCheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {typeTag(type)}
        </span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <span className="block text-sm font-medium text-foreground">{capitalize(label)}</span>
        <AdvancedOnly>
          <span className="block text-xs text-muted-foreground">{capitalize(`${thresholdSummary}.`)}</span>
        </AdvancedOnly>
      </TableCell>
    </TableRow>
  );
}
