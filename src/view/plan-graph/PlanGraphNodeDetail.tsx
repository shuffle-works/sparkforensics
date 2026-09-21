import { X, ArrowLeftRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TagBadge } from '@/view/ImpactBadge';
import { formatBytes } from '@sparkforensics/core/format-utils.ts';
import { findingActionLabel } from '@/view/finding-action-label';
import { CATEGORY_ICON } from '@/view/plan-graph/PlanGraphNode';
import type { PlanGraphNodeData } from '@sparkforensics/core/types.ts';

export type PlanGraphNodeDetailData = PlanGraphNodeData & { durationSharePct: number | null };

// A split Exchange renders as two nodes; the detail card says which half is in
// view so a read half isn't a dead end. Wording matches the read/write
// direction encoded by `splitRole`.
const SPLIT_ROLE_NOTE: Record<'read' | 'write', string> = {
  read: 'Read half. Consumes the shuffle written by its paired write half.',
  write: 'Write half. Produces the shuffle its paired read half consumes.',
};

/** Full, untruncated detail for one plan node, docked as a right-hand inspector
 * when a node is clicked. The node box itself truncates every field to fit a
 * fixed size and shows only one metric; this panel is the only place the whole
 * operator detail, the complete metric set, and the finding list are legible. */
export function PlanGraphNodeDetail({
  node,
  onClose,
  onJumpToPaired,
}: {
  node: PlanGraphNodeDetailData;
  onClose: () => void;
  /** Selects and recenters this Exchange half's paired half. Both halves are
   * always in different segments, so from the single-stage view this expands
   * to the full plan first (owned by the route). */
  onJumpToPaired?: (pairedNodeId: string) => void;
}) {
  const icon = CATEGORY_ICON[node.category] ?? CATEGORY_ICON.transform;
  const findings = node.findings ?? [];
  const metrics = node.metrics ?? [];
  const categoryLabel = node.category.charAt(0).toUpperCase() + node.category.slice(1);

  return (
    <div
      data-testid="plan-node-detail"
      role="dialog"
      aria-label={`Plan node detail: ${node.label}`}
      className="flex h-full w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l border-border bg-card p-3 text-xs"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span aria-hidden="true" className="shrink-0">{icon}</span>
          <span className="break-words font-medium">{node.label}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Close node detail"
          onClick={onClose}
        >
          <X className="size-4" />
        </Button>
      </div>

      <p className="text-muted-foreground">
        {categoryLabel} · Segment {node.segmentIndex + 1}
        {node.durationSharePct != null ? (
          <>
            {' · '}
            <span className="text-foreground">{node.durationSharePct}%</span> of plan stage time
          </>
        ) : null}
      </p>

      {node.splitRole ? (
        <Section title="Exchange">
          <p className="text-muted-foreground">{SPLIT_ROLE_NOTE[node.splitRole]}</p>
          {node.exchangeShuffleBytes != null ? (
            <p className="mt-1 text-muted-foreground">
              Shuffle written{' '}
              <span className="font-medium tabular-nums text-foreground">{formatBytes(node.exchangeShuffleBytes)}</span>
            </p>
          ) : node.label.startsWith('Broadcast') ? (
            <p className="mt-1 text-muted-foreground">Broadcast, no shuffle</p>
          ) : null}
          {node.pairedNodeId && onJumpToPaired ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 w-full justify-start gap-1.5"
              onClick={() => onJumpToPaired(node.pairedNodeId!)}
            >
              <ArrowLeftRight className="size-3.5" aria-hidden="true" />
              Jump to {node.splitRole === 'read' ? 'write' : 'read'} half
            </Button>
          ) : null}
        </Section>
      ) : null}

      {findings.length > 0 ? (
        <Section title="Findings">
          <ul className="flex flex-col gap-1.5">
            {findings.map((f, i) => (
              <li key={f.id ?? `${f.type}-${i}`} className="flex items-start gap-1.5">
                {/* TagBadge (not a bare dot + typeTag) so the pill links into the
                    docs panel like every finding pill on the dashboard. */}
                <TagBadge type={f.type} impactBand={f.impactBand} className="shrink-0" />
                <span className="break-words">{findingActionLabel(f)}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {metrics.length > 0 ? (
        <Section title="Metrics">
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1">
            {metrics.map((m, i) => (
              <div key={`${m.name}-${i}`} className="contents">
                <dt className="min-w-0 break-words text-muted-foreground">{m.name}</dt>
                <dd className="text-right font-medium tabular-nums">{m.value}</dd>
              </div>
            ))}
          </dl>
        </Section>
      ) : null}

      {node.detailText ? (
        <Section title="Plan detail">
          <pre
            data-testid="plan-node-detail-text"
            className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] leading-snug"
          >
            {node.detailText}
          </pre>
        </Section>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 font-medium text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
