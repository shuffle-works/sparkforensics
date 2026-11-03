import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import { useCardStateKey, useWidgetState } from '@/view/useWidgetState';

interface NonLocalStage {
  stageId: number;
  ratio: number;
  nonLocalTasks: number;
  taskCount: number;
}

/** The stages with non-local tasks, a page at a time. */
export function NonLocalStageList({ stages }: { stages: readonly NonLocalStage[] }) {
  const [page, setPage] = useWidgetState(useCardStateKey('non-local-page'), 0);
  const { totalPages, effectivePage, visible } = usePagedRows([...stages], page, setPage);
  if (visible.length === 0) return null;
  return (
    <>
      <ul className="space-y-1 text-xs text-muted-foreground">
        {visible.map((s) => (
          <li key={s.stageId}>
            Stage {s.stageId}: {Math.round(s.ratio * 100)}% non-local ({s.nonLocalTasks}/{s.taskCount} tasks)
          </li>
        ))}
      </ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </>
  );
}
