import { ChevronRightIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { planTreeToDot } from '@sparkforensics/core/plan-dot.ts';
import { useStore } from '@/store/store';
import {
  buildDurationMap,
  classifyNode,
  getPrimaryMetric,
  formatPlanMetricValue,
  parseOperatorDetail,
} from '@sparkforensics/core/plan-node-detail.ts';
import { describePlanNode, summarizePlanTree } from '@sparkforensics/core/plan-summary.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, PlanNode, SqlExecution, StageId } from '@sparkforensics/core/types.ts';
import { Section, type Row } from '@/view/Section';
import { TagBadge } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

interface ScanSummary { path: string; format: string; projectedColumns: string[]; pushedFilters: string[]; sql?: string; }
interface JoinSummary { joinType: string; leftKeys: string[]; rightKeys: string[]; }
interface AggSummary { groupByKeys: string[]; aggregations: string[]; }
interface ExchangeSummary { partitioning: string; keys: string[]; numPartitions: number; }
interface PlanWarning { type: string; detail: string; }
interface PlanSummary {
  scans: ScanSummary[];
  joins: JoinSummary[];
  aggs: AggSummary[];
  exchanges: ExchangeSummary[];
  warnings: PlanWarning[];
}

interface NodeDetail {
  kind: 'scan' | 'join' | 'agg' | 'exchange' | null;
  warning: PlanWarning | null;
  path?: string;
  format?: string;
  projectedColumns?: string[];
  pushedFilters?: string[];
  joinType?: string;
  leftKeys?: string[];
  rightKeys?: string[];
  groupByKeys?: string[];
  aggregations?: string[];
  partitioning?: string;
  keys?: string[];
  numPartitions?: number;
}

// Plan warnings/the manyExchanges advisory come from best-effort regex
// parsing of the plan text (describePlanNode/summarizePlanTree): each
// affected row/node still gets its own low-confidence RowStatusCluster
// badge at Advanced density, but the "verify this before acting" caveat
// itself renders once per tab (Tree) or once per section (Summary) rather
// than once per warning - see PlanView's Tree-tab caveat and
// PlanSummaryTab's `showPlanValidation` for why.
//
// Two distinct strings instead of one shared constant, because a single
// wording can't fit both places: the Tree tab's instance can't tell the
// user to "cross-check against the Tree tab" while they're already looking
// at it, so it points at the Summary tab instead. The Summary tab's
// instance points back at the Tree tab, and only names "View plan graph"
// when `safeDot()` actually produced one (PlanView's `dot`) - otherwise the
// caveat would send the user looking for a button that isn't on screen.
const PLAN_VALIDATION_TREE =
  'Derived from best-effort plan-text parsing: cross-check against the Summary tab before acting.';
const PLAN_VALIDATION_SUMMARY =
  'Derived from best-effort plan-text parsing: cross-check against the Tree tab before acting.';
const PLAN_VALIDATION_SUMMARY_WITH_GRAPH =
  'Derived from best-effort plan-text parsing: cross-check against the Tree tab or View plan graph before acting.';

function safeDescribeNode(node: PlanNode): NodeDetail | null {
  try {
    return describePlanNode(node) as NodeDetail | null;
  } catch {
    return null;
  }
}

function safeSummarize(planTree: PlanNode): PlanSummary | null {
  try {
    return summarizePlanTree(planTree) as PlanSummary;
  } catch {
    return null;
  }
}

function safeDot(planTree: PlanNode, stageId: StageId): string | null {
  try {
    return planTreeToDot(planTree, { title: `stage-${stageId}` }) || null;
  } catch {
    return null;
  }
}

/** Degrade-gracefully contract for the per-node duration attribution: a
 * failure here (e.g. a malformed node from a truncated event log) degrades
 * to "no duration data" instead of blanking the whole Tree/Summary render. */
function safeBuildDurationMap(
  planTree: PlanNode,
  appModel: AppModel,
  sqlExec: SqlExecution | null | undefined,
  executionId: number | null | undefined,
): Map<PlanNode, number> | null {
  if (!sqlExec || executionId == null) return null;
  try {
    return buildDurationMap(planTree, appModel, sqlExec, executionId);
  } catch {
    return null;
  }
}

/** Resolves the SQL plan tree linked to a stage, or null if the stage has no
 * SQL execution or that execution has no plan tree. Shared by PlanView (to
 * decide what to render) and its callers (to decide whether to render their
 * own wrapper, a Collapsible toggle or a static section heading, at all). */
export function resolvePlanTree(stageId: StageId, appModel: AppModel): PlanNode | null {
  const stage = appModel.stages.get(stageId);
  const linkedSql = stage?.sqlExecutionId != null ? appModel.sql.get(stage.sqlExecutionId) : null;
  return linkedSql?.planTree ?? null;
}

/** The full structured fields for one node, attached to the operator it
 * describes. */
function nodeDetailRows(detail: NodeDetail): Row[] {
  switch (detail.kind) {
    case 'scan':
      return [
        detail.path ? ['Path', detail.path] : null,
        detail.format ? ['Format', detail.format] : null,
        detail.projectedColumns?.length ? ['Columns', detail.projectedColumns.join(', ')] : null,
        detail.pushedFilters?.length ? ['Filters', detail.pushedFilters.join(', ')] : null,
      ];
    case 'join':
      return [
        ['Left keys', detail.leftKeys?.length ? detail.leftKeys.join(', ') : '(none)'],
        ['Right keys', detail.rightKeys?.length ? detail.rightKeys.join(', ') : '(none)'],
      ];
    case 'agg':
      return [
        ['Group by', detail.groupByKeys?.length ? detail.groupByKeys.join(', ') : '(none)'],
        ['Functions', detail.aggregations?.length ? detail.aggregations.join(', ') : '(none)'],
      ];
    case 'exchange':
      return [
        detail.partitioning ? ['Partitioning', detail.partitioning] : null,
        detail.keys?.length ? ['Keys', detail.keys.join(', ')] : null,
        detail.numPartitions ? ['Partitions', String(detail.numPartitions)] : null,
      ];
    default:
      return [];
  }
}

/** Nested disclosure for a node's full structured fields. Renders the
 * `Section` only while open: a plain uncontrolled `<details>` leaves its
 * child DOM in place at all times (browsers hide it visually via the UA
 * stylesheet, which jsdom does not apply), so an always-rendered `Section`
 * would defeat the collapsed-by-default intent under test. */
function FullDetailToggle({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="pt-1 pl-4"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-xs text-muted-foreground">full detail</summary>
      {open ? (
        <div className="pt-1">
          <Section rows={rows} />
        </div>
      ) : null}
    </details>
  );
}

interface PlanTreeNodeProps {
  node: PlanNode;
  depth: number;
  durationMap: Map<PlanNode, number> | null;
}

/** One expandable plan operator: auto-open for the first two levels, set
 * imperatively via a ref so a later re-render doesn't stomp a user's manual
 * toggle. The chevron's rotation tracks the native `open` state via the
 * `toggle` event, not a `group-open:` CSS selector: recursively nested
 * `<details>` share an ancestor chain, so a descendant selector can't tell
 * "this node is open" from "some ancestor is open". */
function PlanTreeNode({ node, depth, durationMap }: PlanTreeNodeProps) {
  const ref = useRef<HTMLDetailsElement>(null);
  const [isOpen, setIsOpen] = useState(depth <= 1);
  useEffect(() => {
    if (ref.current) ref.current.open = depth <= 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial open state only, see comment above
  }, []);

  const opType = classifyNode(node.name);
  const detailFull = node.detail ?? '';
  const nodeDetail = safeDescribeNode(node);
  const detailRows = nodeDetail ? nodeDetailRows(nodeDetail) : [];
  const hasFullDetail = detailRows.some(Boolean);
  // For scans the smart hint is just the bare format, which the full-detail
  // panel below already shows under "Format"; drop it here to avoid repeating it.
  const detailSmart = nodeDetail?.kind === 'scan' ? '' : parseOperatorDetail(node.name, detailFull);
  // A read half wrapping a write half (the Exchange split from
  // resolvePlanTree, see event-handlers.ts) is one logical operator for
  // this legacy tree view, which pre-dates the split (PlanGraphNode.tsx is
  // the newer view that shows both halves separately). The read half
  // occupies the exact tree position the original unsplit node used to, but
  // the write half carries the real metrics, duration, and real children,
  // one level deeper. Pull all three up here so this renders as one merged
  // row instead of two nested ones.
  const writeHalf = node.exchangeRole === 'read' ? node.children[0] : undefined;
  const durMs = durationMap?.get(writeHalf ?? node);
  const metrics = (writeHalf ?? node).metrics ?? [];
  const primaryMetric = metrics.length > 0 ? getPrimaryMetric(metrics) : '';
  const children = (writeHalf ?? node).children ?? [];
  const hasExpandableContent = children.length > 0 || metrics.length > 0 || hasFullDetail;

  return (
    <details
      ref={ref}
      data-op={opType}
      className="rounded-md"
      onToggle={(e) => setIsOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        className={`flex list-none flex-wrap items-center gap-2 rounded-md px-1.5 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden ${
          hasExpandableContent ? 'cursor-pointer hover:bg-muted' : 'cursor-default'
        }`}
      >
        {hasExpandableContent ? (
          <ChevronRightIcon
            aria-hidden="true"
            className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${isOpen ? 'rotate-90' : ''}`}
          />
        ) : (
          <span className="size-3.5 shrink-0" />
        )}
        <span className="font-medium">{node.name}</span>
        {detailSmart ? (
          <span title={detailFull} className="text-xs text-muted-foreground">
            {detailSmart}
          </span>
        ) : null}
        {nodeDetail?.warning ? (
          <>
            <TagBadge type="duplicatePlanSubtree" impactBand="warning" className={PLAN_TAG_CLASS} />
            <span className="text-xs text-muted-foreground">{nodeDetail.warning.detail}</span>
            <AdvancedOnly>
              <RowStatusCluster confidence="low" />
            </AdvancedOnly>
          </>
        ) : null}
        {durMs != null && durMs > 0 ? (
          <span
            title="Approximate wall-time attributed to this operator"
            className="text-xs text-muted-foreground"
          >
            ~{formatDuration(durMs)}
          </span>
        ) : null}
        {primaryMetric ? <span className="text-xs text-muted-foreground">{primaryMetric}</span> : null}
      </summary>
      {metrics.length > 0 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1 pl-6 text-xs text-muted-foreground">
          {metrics.map((m, i) => (
            <span key={i}>
              {m.name}: {formatPlanMetricValue(m)}
            </span>
          ))}
        </div>
      ) : null}
      {hasFullDetail ? <FullDetailToggle rows={detailRows} /> : null}
      {children.length > 0 ? (
        <div className="ml-[7px] space-y-1 border-l border-border/60 pt-1 pl-3.5">
          {children.map((c, i) => (
            <PlanTreeNode key={i} node={c} depth={depth + 1} durationMap={durationMap} />
          ))}
        </div>
      ) : null}
    </details>
  );
}

function scanLine(s: ScanSummary): string {
  return `${s.path || '(unknown path)'} (${s.format})`;
}
function joinLine(j: JoinSummary): string {
  const keys = j.leftKeys.length || j.rightKeys.length
    ? ` on ${j.leftKeys.join(', ') || '(none)'} / ${j.rightKeys.join(', ') || '(none)'}`
    : '';
  return `${j.joinType}${keys}`;
}
function aggLine(a: AggSummary): string {
  const funcs = a.aggregations.join(', ') || '(none)';
  return a.groupByKeys.length ? `${funcs} by ${a.groupByKeys.join(', ')}` : funcs;
}
function exchangeLines(exchanges: ExchangeSummary[]): string {
  const counts = new Map<string, number>();
  for (const x of exchanges) counts.set(x.partitioning, (counts.get(x.partitioning) ?? 0) + 1);
  return [...counts.entries()].map(([kind, count]) => `${kind}×${count}`).join(', ');
}

/** Condensed per-category rollup, one line each from summarizePlanTree: the
 * "how many, of what kind" answer. The Tree tab holds a node's full fields. */
function PlanSummaryTab({ summary, hasPlanGraph }: { summary: PlanSummary; hasPlanGraph: boolean }) {
  const { scans, joins, aggs, exchanges, warnings } = summary;
  const manyExchanges = exchanges.length >= 4;
  // Both the exchanges-advisory row and the warnings row can carry the same
  // caveat; render it once for the section rather than once per row so a
  // plan with both doesn't show the identical sentence twice.
  const showPlanValidation = manyExchanges || warnings.length > 0;
  const planValidationText = hasPlanGraph ? PLAN_VALIDATION_SUMMARY_WITH_GRAPH : PLAN_VALIDATION_SUMMARY;

  return (
    <Section
      rows={[
        scans.length > 0 && [`Sources (${scans.length})`, scans.map(scanLine).join(', ')],
        joins.length > 0 && [`Joins (${joins.length})`, joins.map(joinLine).join('; ')],
        aggs.length > 0 && [`Aggregations (${aggs.length})`, aggs.map(aggLine).join('; ')],
        exchanges.length > 0 && [
          `Exchanges (${exchanges.length})`,
          <>
            {exchangeLines(exchanges)}
            {manyExchanges ? (
              <>
                {' '}
                <span className="text-muted-foreground">
                  &mdash; consider whether some joins/aggregations could share a partitioning scheme to avoid
                  redundant shuffles.
                </span>{' '}
                <AdvancedOnly>
                  <RowStatusCluster confidence="low" />
                </AdvancedOnly>
              </>
            ) : null}
          </>,
        ],
        warnings.length > 0 && [
          `Warnings (${warnings.length})`,
          <span className="flex flex-wrap items-center gap-1.5">
            <TagBadge type="duplicatePlanSubtree" impactBand="warning" className={PLAN_TAG_CLASS} />
            {warnings.map((w) => w.detail).join('; ')}
            <AdvancedOnly>
              <RowStatusCluster confidence="low" />
            </AdvancedOnly>
          </span>,
        ],
      ]}
    >
      {showPlanValidation ? (
        <AdvancedOnly>
          <p className="text-xs text-muted-foreground">{planValidationText}</p>
        </AdvancedOnly>
      ) : null}
    </Section>
  );
}

export interface PlanViewProps {
  stageId: StageId;
  appModel: AppModel;
}

/** Shared SQL-plan view for a stage: a hierarchical physical-plan tree
 * (default tab) plus a condensed per-category summary (second tab), used by
 * both the Stage detail modal's "Query Plan" section and PlanExplorer's
 * inline "Plan context" disclosure. Renders nothing when the stage has no
 * linked SQL execution or plan tree; degrades to a plain message if the tree
 * fails to parse, but never throws. */
export function PlanView({ stageId, appModel }: PlanViewProps) {
  const openPlanGraph = useStore((s) => s.openPlanGraph);
  const planTree = resolvePlanTree(stageId, appModel);
  if (!planTree) return null;

  const stage = appModel.stages.get(stageId);
  const linkedSql = stage?.sqlExecutionId != null ? appModel.sql.get(stage.sqlExecutionId) : null;

  const durationMap = safeBuildDurationMap(planTree, appModel, linkedSql, stage?.sqlExecutionId);

  const summary = safeSummarize(planTree);
  const dot = safeDot(planTree, stageId);

  return (
    <Tabs defaultValue="tree">
      <div className="flex items-center justify-between gap-2">
        <TabsList aria-label="Plan view">
          <TabsTrigger value="tree">Tree</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>
        <div className="flex gap-2">
          {dot ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => openPlanGraph(stageId)}>
              View plan graph
            </Button>
          ) : null}
        </div>
      </div>

      <TabsContent value="tree">
        <div className="space-y-2 pt-3">
          <PlanTreeNode node={planTree} depth={0} durationMap={durationMap} />
          <AdvancedOnly>
            <p className="text-xs text-muted-foreground">
              Showing initial (pre-AQE) plan. Metrics reflect operators as planned; adaptive optimizations may have
              rewritten the actual execution.
            </p>
          </AdvancedOnly>
          {/* Once per tab, not once per warning node: a per-node instance
              inside a <summary> would need to survive the node's own
              collapse (warning nodes routinely sit below the depth<=1
              auto-open cutoff), but that also puts the sentence inside
              every warning node's click target and repeats it once per
              node in the accessible-name tree. The per-node badge + this
              node's own warning detail text already say which operator is
              affected; this caveat only needs to say "go verify," once. */}
          {summary && summary.warnings.length > 0 ? (
            <AdvancedOnly>
              <p className="text-xs text-muted-foreground">{PLAN_VALIDATION_TREE}</p>
            </AdvancedOnly>
          ) : null}
        </div>
      </TabsContent>

      <TabsContent value="summary">
        <div className="pt-3">
          {summary ? (
            <PlanSummaryTab summary={summary} hasPlanGraph={dot != null} />
          ) : (
            <p className="text-xs text-muted-foreground">Plan summary couldn&rsquo;t be parsed.</p>
          )}
        </div>
      </TabsContent>
    </Tabs>
  );
}
