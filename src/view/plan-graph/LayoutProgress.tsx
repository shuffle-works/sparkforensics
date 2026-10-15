import { Progress } from '@/components/ui/progress';

/** The wait for a large plan's layout: a bar with no percentage, because the
 * layout worker reports only when it is done, and the message beside it. The
 * first open fills the canvas and centers it; a relayout over a graph already on
 * screen shows the compact form in a banner. */
export function LayoutProgress({ compact = false }: { compact?: boolean }) {
  const bar = <Progress value={null} aria-label="Layout progress" className="w-full" />;
  if (compact) {
    return (
      <div role="status" aria-live="polite" className="flex w-56 flex-col gap-2 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
        <p>Laying out plan graph…</p>
        {bar}
      </div>
    );
  }
  return (
    <div role="status" aria-live="polite" aria-label="Laying out plan graph" className="flex h-full min-h-[50vh] w-full flex-col items-center justify-center gap-3 p-6">
      <p className="text-sm text-muted-foreground">Laying out plan graph…</p>
      <div className="w-full max-w-xs">{bar}</div>
    </div>
  );
}
