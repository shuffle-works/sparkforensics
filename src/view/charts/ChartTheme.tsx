import { Children, cloneElement, isValidElement, useState, type ComponentProps, type ReactNode } from 'react';
import { Area, Bar, Line, Pie, Radar, RadialBar, ResponsiveContainer, Scatter } from 'recharts';

import { ChartContainer } from '@/components/ui/chart';
import { copyText } from '@/lib/clipboard';
import { useReducedMotion } from './useReducedMotion';
import { useDisclosureOpen } from '@/view/DisclosureContext';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// CSS-variable-backed so Recharts (literal color strings only) tracks the live
// theme/dark-mode swap instead of a build-time snapshot.
export const CHART_COLORS = {
  accent: 'var(--color-accent)',
  warning: 'var(--color-warning)',
  critical: 'var(--color-critical)',
  info: 'var(--color-info)',
  clean: 'var(--color-clean)',
  muted: 'var(--color-muted-foreground)',
} as const;

// Recharts' default tooltip is a white box whose label inherits the page text
// color, so in the dark theme a near-white label sat on white. Every tooltip
// spreads these props to draw on the theme's popover surface instead.
const TOOLTIP_TEXT = 'var(--color-popover-foreground)';
export const CHART_TOOLTIP_BOX_STYLE = {
  background: 'var(--color-popover)',
  border: '1px solid var(--color-border)',
  borderRadius: 6,
  color: TOOLTIP_TEXT,
  fontSize: 12,
  padding: '6px 10px',
} as const;
export const CHART_TOOLTIP_PROPS = {
  contentStyle: CHART_TOOLTIP_BOX_STYLE,
  labelStyle: { color: TOOLTIP_TEXT, fontWeight: 600 },
  itemStyle: { color: TOOLTIP_TEXT },
} as const;

export interface ChartTableSpec {
  caption: string;
  columns: string[];
  rows: (string | number)[][];
  align?: Array<'left' | 'right'>;
}

export function chartTableToTSV(columns: string[], rows: (string | number)[][]): string {
  return [columns, ...rows].map((r) => r.join('\t')).join('\n');
}

// Table stays in the DOM (sr-only when collapsed) so assistive tech can read it
// regardless of toggle state; copy reads columns/rows directly, not the DOM.
export function ChartCopyBar({ caption, columns, rows, align }: ChartTableSpec) {
  const [showTable, setShowTable] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await copyText(chartTableToTSV(columns, rows));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can fail (permissions, embed context); no user-facing
      // error state needed for this affordance.
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="cursor-pointer text-muted-foreground text-xs underline"
          aria-expanded={showTable}
          onClick={() => setShowTable((s) => !s)}
        >
          ▤ Table
        </button>
        <button type="button" className="cursor-pointer text-muted-foreground text-xs underline" onClick={handleCopy}>
          ⧉ Copy
        </button>
        <span aria-live="polite" className="text-xs text-muted-foreground">
          {copied ? 'Copied' : ''}
        </span>
      </div>
      <Table className={showTable ? undefined : 'sr-only'}>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          <TableRow>
            {columns.map((c, i) => (
              <TableHead key={c} className={align?.[i] === 'right' ? 'text-right' : undefined}>
                {c}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, i) => (
            <TableRow key={i}>
              {row.map((cell, j) => (
                <TableCell key={j} className={align?.[j] === 'right' ? 'text-right' : undefined}>
                  {cell}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export interface ChartFrameProps {
  title?: string;
  ariaLabel: string;
  height: number;
  children: ComponentProps<typeof ResponsiveContainer>['children'];
  table?: ChartTableSpec;
}

// Recharts series that play a JS entry animation; extend if a new animated
// series type is introduced.
const ANIMATABLE_SERIES = new Set<unknown>([Area, Bar, Line, Pie, Radar, RadialBar, Scatter]);

// Force isAnimationActive={false} on every animatable series that hasn't set it
// explicitly. Injecting once here (the wrapper every chart routes through) keeps
// the reduced-motion contract from regressing as widgets are added.
export function disableSeriesAnimation(node: ReactNode): ReactNode {
  if (!isValidElement<{ children?: ReactNode; isAnimationActive?: boolean }>(node)) return node;
  const { children, isAnimationActive } = node.props;
  const mappedChildren = children == null ? children : Children.map(children, disableSeriesAnimation);
  const needsFlag = ANIMATABLE_SERIES.has(node.type) && isAnimationActive === undefined;
  if (!needsFlag && mappedChildren === children) return node;
  return cloneElement(
    node,
    needsFlag ? { isAnimationActive: false } : {},
    ...(children == null ? [] : [mappedChildren]),
  );
}

// Height-pinned wrapper around shadcn's ChartContainer. height passes through as
// both inline style and initialDimension, which ResponsiveContainer falls back
// to when it can't observe a real layout size (jsdom has no ResizeObserver; an
// unpainted card is another), so charts never grow unbounded.
export function ChartFrame({ title, ariaLabel, height, children, table }: ChartFrameProps): ReactNode {
  const reducedMotion = useReducedMotion();
  const content = reducedMotion ? (disableSeriesAnimation(children) as typeof children) : children;
  // A collapsed WidgetCard keeps its body mounted but hidden at 0×0; mounting
  // ResponsiveContainer there logs a width(0)/height(0) warning and wastes
  // layout work, so hold a same-height spacer until the disclosure opens.
  const disclosureOpen = useDisclosureOpen();
  return (
    <div className="flex flex-col gap-1">
      {title ? <p className="text-muted-foreground text-xs font-medium">{title}</p> : null}
      {disclosureOpen ? (
        <ChartContainer
          role="img"
          aria-label={ariaLabel}
          config={{}}
          className="aspect-auto w-full"
          style={{ height }}
          initialDimension={{ width: 320, height }}
        >
          {content}
        </ChartContainer>
      ) : (
        <div style={{ height }} aria-hidden />
      )}
      {table ? <ChartCopyBar {...table} /> : null}
    </div>
  );
}
