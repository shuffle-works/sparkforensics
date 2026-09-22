import { useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import {
  type ColumnDef,
  type PaginationState,
  type SortingState,
  columnVisibilityFeature,
  createPaginatedRowModel,
  createSortedRowModel,
  flexRender,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';

const stageTableFeatures = tableFeatures({
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
});

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes, formatDuration, SPILL_CLASS_SHORT, SPILL_CLASS_TITLE, stageWidgetFrequency, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { Chip, TagBadge } from '@/view/ImpactBadge';
import { useStageDetail } from '@/view/StageDetailContext';
import { useWidgetDensity } from '@/store/store';
import { formatImpactEstimateCompact } from '../ImpactEstimate.tsx';
import { WidgetCard } from '@/view/WidgetCard';
import type { AppModel, Finding, Stage, TaskData } from '@sparkforensics/core/types.ts';
import { selectTriageTargetForFinding, type TriageTarget } from '@/view/triage-target';

const PAGE_SIZE = 10;
const TOP_N = 10;
const RIGHT_ALIGNED_COLUMNS = new Set([
  'duration', 'taskCount', 'shuffleRead', 'fetchWait', 'gcPct', 'skew', 'spill',
]);

interface Row {
  stage: Stage;
  tags: Finding[];
  frequency: number;
}

export interface StageTableProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (id: number) => Promise<TaskData>;
  onRoute?: (target: TriageTarget) => void;
}

function truncate(str: string, n: number): string {
  return str.length > n ? `${str.slice(0, n)}…` : str;
}

function retriedCell(failed: number) {
  if (failed <= 0) return <>0</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {failed} <Chip label="RETRY" impactBand="critical" />
    </span>
  );
}

/** Basic density keeps the duration and the colored flag chip but drops the
 * precise percentage: a raw ratio number that needs the same Spark-internals
 * context as I/O Ratio, GC%, and Skew P95/median. */
function fetchWaitCell(fetchWait: number, runTime: number, density: 'basic' | 'advanced') {
  if (fetchWait <= 0) return <>{'—'}</>;
  const formatted = formatDuration(fetchWait);
  if (runTime <= 0) return <>{formatted}</>;
  const ratio = fetchWait / runTime;
  if (ratio > 0.3) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {formatted} <Chip label={density === 'advanced' ? `${Math.round(ratio * 100)}%` : 'High'} impactBand="critical" />
      </span>
    );
  }
  if (ratio > 0.15) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {formatted} <Chip label={density === 'advanced' ? `${Math.round(ratio * 100)}%` : 'Elevated'} impactBand="info" />
      </span>
    );
  }
  return <>{formatted}</>;
}

function ioRatioCell(inputBytes: number, outputBytes: number) {
  if (!inputBytes || inputBytes <= 0) return <>{'—'}</>;
  if (!outputBytes || outputBytes <= 0) return <>{'—'}</>;
  const ratio = outputBytes / inputBytes;
  const formatted = ratio < 0.01 ? `${ratio.toExponential(1)}×` : `${ratio.toFixed(2)}×`;
  if (ratio > 2.0 || ratio < 0.1) {
    return (
      <span className="inline-flex items-center gap-1.5">
        {formatted} <Chip label="extreme" impactBand="info" />
      </span>
    );
  }
  return <>{formatted}</>;
}

function spillCell(memoryBytesSpilled: number, classification: Stage['spillClassification']) {
  if (memoryBytesSpilled <= 0) return <>{'—'}</>;
  const cls = classification ?? 'unclassified';
  return (
    <span className="inline-flex items-center gap-1.5">
      {formatBytes(memoryBytesSpilled)}{' '}
      <Chip label={SPILL_CLASS_SHORT[cls]} impactBand="warning" title={SPILL_CLASS_TITLE[cls]} />
    </span>
  );
}

function ratioValue(p50: number | undefined, p95: number | undefined): number {
  if (!p50 || p50 <= 0) return 0;
  return (p95 ?? 0) / p50;
}

/** Dedup a stage's findings by `type`, keeping the worst-impact-band instance of
 * each: detectors like `stageShape`/`partitionSizing`/`slowHost` can push
 * several same-type findings per stage, which would otherwise render as repeated
 * identical chips (e.g. "SHAPE SHAPE SHAPE"). */
function dedupTagsByType(tags: Finding[]): Finding[] {
  const byType = new Map<string, Finding[]>();
  for (const t of tags) {
    if (!byType.has(t.type)) byType.set(t.type, []);
    byType.get(t.type)!.push(t);
  }
  return [...byType.values()].map((group) => {
    const worst = worstImpactBand(group);
    return group.find((f) => f.impactBand === worst) ?? group[0];
  });
}

/** Stage-by-stage summary table (shadcn `Table` + tanstack `useReactTable`).
 * Defaults to the top-N-by-duration view; a toggle switches to the
 * problem-stage view (only stages any board widget flagged). Sorting and
 * pagination are local `useState`, not persisted. */
export function StageTable({ appModel, catalog, getTaskData: _getTaskData, onRoute }: StageTableProps) {
  const { openStage } = useStageDetail();
  const density = useWidgetDensity();
  const [showProblems, setShowProblems] = useState(false);
  const [nameFilter, setNameFilter] = useState('');
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: PAGE_SIZE });

  const { catalogByStage, flaggedStageIds, frequency } = useMemo(() => {
    const byStage = new Map<number, Finding[]>();
    const flagged = new Set<number>();
    for (const b of catalog) {
      if (b.stageId == null) continue;
      flagged.add(b.stageId as number);
      if (!byStage.has(b.stageId as number)) byStage.set(b.stageId as number, []);
      byStage.get(b.stageId as number)!.push(b);
    }
    return { catalogByStage: byStage, flaggedStageIds: flagged, frequency: stageWidgetFrequency(catalog) };
  }, [catalog]);

  const rows: Row[] = useMemo(() => {
    const stages = [...appModel.stages.values()];
    const selected = showProblems
      ? stages.filter((s) => flaggedStageIds.has(s.id))
      : [...stages]
          .sort(
            (a, b) =>
              (b.completedAt ?? 0) - (b.submittedAt ?? 0) - ((a.completedAt ?? 0) - (a.submittedAt ?? 0)),
          )
          .slice(0, TOP_N);
    const needle = nameFilter.trim().toLowerCase();
    const filtered = needle
      ? selected.filter((s) => (s.name ?? '').toLowerCase().includes(needle) || String(s.id).includes(needle))
      : selected;
    return filtered.map((stage) => ({
      stage,
      tags: dedupTagsByType(catalogByStage.get(stage.id) ?? []),
      frequency: frequency.get(stage.id) ?? 0,
    }));
  }, [appModel.stages, showProblems, flaggedStageIds, catalogByStage, frequency, nameFilter]);

  // Resolve triage targets once per catalog change instead of on every
  // rendered tag (each resolution is several linear scans over `catalog`, and
  // tags re-render on table churn like sorting/dragging). Tag findings hold
  // catalog references, so the cell can look targets up by identity.
  const triageTargets = useMemo(() => {
    if (!onRoute) return null;
    const map = new Map<Finding, TriageTarget>();
    for (const finding of catalog) {
      const target = selectTriageTargetForFinding(finding, catalog);
      if (target) map.set(finding, target);
    }
    return map;
  }, [catalog, onRoute]);

  const columns = useMemo<ColumnDef<typeof stageTableFeatures, Row>[]>(
    () => [
      {
        id: 'id',
        header: 'Stage',
        accessorFn: (r) => r.stage.id,
        // Real button = the row's accessible primary action (role + native
        // Enter/Space); the row's own onClick stays as a pointer-only
        // redundancy. role="button" on the <tr> itself would rip the row out
        // of the table structure for assistive tech.
        cell: ({ getValue }) => {
          const id = getValue<number>();
          return (
            <button
              type="button"
              // Distinct from StagePill's "Open details for Stage N" so the
              // two controls stay distinguishable (and uniquely queryable)
              // when both render on the same dashboard.
              aria-label={`Open Stage ${id} details`}
              className="inline-flex cursor-pointer items-center rounded-sm hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={(event) => {
                event.stopPropagation();
                openStage(id);
              }}
            >
              <strong>{id}</strong>
            </button>
          );
        },
      },
      {
        id: 'name',
        header: 'Operation',
        accessorFn: (r) => r.stage.name ?? '',
        cell: ({ row }) => {
          const stageId = row.original.stage.id;
          return (
            <span className="inline-flex flex-wrap items-center gap-1.5">
              {truncate(row.original.stage.name ?? '', 40)}
              {row.original.tags.map((t, i) => {
                const target = triageTargets ? (triageTargets.get(t) ?? null) : null;
                const route = target && onRoute ? { target, onRoute } : null;
                const compact = formatImpactEstimateCompact(t.impactEstimate);
                return (
                  <span key={i} className="inline-flex items-center gap-1">
                    {route ? (
                      <button
                        type="button"
                        aria-label={`Investigate ${route.target.findingLabel} in Stage ${stageId}`}
                        title={`Investigate ${route.target.findingLabel} in Stage ${stageId}`}
                        className="inline-flex cursor-pointer items-center rounded-full hover:underline underline-offset-2 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        onClick={(event) => {
                          event.stopPropagation();
                          route.onRoute(route.target);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
                        }}
                      >
                        <TagBadge type={t.type} impactBand={t.impactBand} plainBadge />
                      </button>
                    ) : (
                      <TagBadge type={t.type} impactBand={t.impactBand} />
                    )}
                    {compact ? <span className="text-xs text-muted-foreground">{compact}</span> : null}
                  </span>
                );
              })}
            </span>
          );
        },
      },
      {
        id: 'type',
        header: 'Type',
        accessorFn: (r) => r.stage.stageType ?? '',
        cell: ({ row }) => <Badge variant="outline">{row.original.stage.stageType ?? '—'}</Badge>,
      },
      {
        id: 'duration',
        header: 'Duration',
        accessorFn: (r) => (r.stage.completedAt ?? 0) - (r.stage.submittedAt ?? 0),
        cell: ({ getValue }) => <>{formatDuration(getValue<number>())}</>,
      },
      {
        id: 'taskCount',
        header: 'Tasks',
        accessorFn: (r) => r.stage.taskCount,
      },
      {
        id: 'retried',
        header: 'Retried',
        accessorFn: (r) => r.stage.failedTasks ?? 0,
        cell: ({ getValue }) => retriedCell(getValue<number>()),
      },
      {
        id: 'shuffleRead',
        header: 'Shuffle Read',
        accessorFn: (r) => r.stage.shuffleReadBytes ?? 0,
        cell: ({ getValue }) => <>{formatBytes(getValue<number>())}</>,
      },
      {
        id: 'fetchWait',
        header: 'Fetch Wait',
        accessorFn: (r) => r.stage.fetchWaitTime ?? 0,
        cell: ({ row }) => fetchWaitCell(row.original.stage.fetchWaitTime ?? 0, row.original.stage.executorRunTime ?? 0, density),
      },
      // I/O Ratio, GC%, and Skew P95/median are raw statistical ratios that
      // need Spark-internals knowledge to interpret and mostly duplicate
      // signal already surfaced as plain-language findings/tags in the
      // Operation column; Advanced-only, unlike every other column here.
      ...(density === 'advanced'
        ? ([
            {
              id: 'ioRatio',
              header: 'I/O Ratio',
              accessorFn: (r) => (r.stage.inputBytes ? (r.stage.outputBytes ?? 0) / r.stage.inputBytes : 0),
              cell: ({ row }) => ioRatioCell(row.original.stage.inputBytes ?? 0, row.original.stage.outputBytes ?? 0),
            },
          ] satisfies ColumnDef<typeof stageTableFeatures, Row>[])
        : []),
      {
        id: 'spill',
        header: 'Spill (mem)',
        accessorFn: (r) => r.stage.memoryBytesSpilled ?? 0,
        cell: ({ row }) => spillCell(row.original.stage.memoryBytesSpilled ?? 0, row.original.stage.spillClassification),
      },
      ...(density === 'advanced'
        ? ([
            {
              id: 'gcPct',
              header: 'GC%',
              accessorFn: (r) => r.stage.gcPct ?? 0,
              cell: ({ getValue }) => <>{getValue<number>().toFixed(1)}%</>,
            },
            {
              id: 'skew',
              header: 'Skew P95/median',
              accessorFn: (r) => ratioValue(r.stage.taskDurationP50, r.stage.taskDurationP95),
              cell: ({ getValue }) => {
                const v = getValue<number>();
                return <>{v > 0 ? `${v.toFixed(1)}×` : '—'}</>;
              },
            },
          ] satisfies ColumnDef<typeof stageTableFeatures, Row>[])
        : []),
      {
        id: 'frequency',
        header: 'Flagged',
        accessorFn: (r) => r.frequency,
        cell: ({ getValue }) => {
          const v = getValue<number>();
          if (v <= 1) return <>{'—'}</>;
          return <Badge variant="outline">{`Flagged by ${v}`}</Badge>;
        },
      },
    ],
    [catalog, onRoute, triageTargets, openStage, density],
  );

  const table = useTable({
    features: stageTableFeatures,
    data: rows,
    columns,
    state: { sorting, pagination },
    // First click = asc, second = desc (tanstack defaults to desc-first for
    // numeric columns).
    sortDescFirst: false,
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
  });

  function toggleView() {
    setShowProblems((v) => !v);
    setSorting([]);
    setPagination({ pageIndex: 0, pageSize: PAGE_SIZE });
  }

  const sortArrow = (dir: false | 'asc' | 'desc') => (dir === 'asc' ? ' ▲' : dir === 'desc' ? ' ▼' : '');
  const ariaSort = (dir: false | 'asc' | 'desc') =>
    dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none';

  return (
    <WidgetCard title="Stage Summary">
      <div className="space-y-3">
        <Input
          type="text"
          value={nameFilter}
          onChange={(e) => {
            setNameFilter(e.target.value);
            setPagination((p) => ({ ...p, pageIndex: 0 }));
          }}
          placeholder="Filter by stage name or ID…"
          aria-label="Filter by stage name or ID"
          className="max-w-xs"
        />
        <div className="flex items-center justify-between gap-2">
          <p className="text-muted-foreground text-xs">Scroll sideways to see all columns &rarr;</p>
          <Button type="button" variant="outline" size="sm" onClick={toggleView}>
            {showProblems ? `Top ${TOP_N} by duration` : 'Problems only'}
          </Button>
        </div>
        <p className="sr-only" role="status" aria-live="polite">
          Showing {rows.length} stage{rows.length === 1 ? '' : 's'}: {' '}
          {showProblems ? 'problems only' : `top ${TOP_N} by duration`}.
        </p>

        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortDir = header.column.getIsSorted();
                  const sortHandler = header.column.getToggleSortingHandler();
                  return (
                    <TableHead
                      key={header.id}
                      scope="col"
                      tabIndex={header.column.getCanSort() ? 0 : undefined}
                      aria-sort={ariaSort(sortDir)}
                      className={cn(
                        header.column.getCanSort() && 'tap-target-comfortable cursor-pointer select-none',
                        RIGHT_ALIGNED_COLUMNS.has(header.column.id) && 'text-right',
                      )}
                      onClick={sortHandler}
                      onKeyDown={(e) => {
                        if (!sortHandler) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          sortHandler(e);
                        }
                      }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {sortArrow(sortDir)}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columns.length} className="text-muted-foreground">
                  <span className="flex items-center justify-center gap-2 py-2">
                    <Inbox aria-hidden="true" className="size-4 shrink-0" />
                    No stages to show.
                  </span>
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow
                  key={row.id}
                  // Pointer-only convenience: the accessible primary action is
                  // the real "Open details" button in the Stage cell.
                  className="cursor-pointer"
                  onClick={() => openStage(row.original.stage.id)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell
                      key={cell.id}
                      className={RIGHT_ALIGNED_COLUMNS.has(cell.column.id) ? 'text-right' : undefined}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {table.getPageCount() > 1 ? (
          <div className="flex items-center justify-end gap-2 text-xs">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="tap-target-comfortable"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              Previous
            </Button>
            <span className="text-muted-foreground">
              Page {pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="tap-target-comfortable"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              Next
            </Button>
          </div>
        ) : null}
      </div>
    </WidgetCard>
  );
}
