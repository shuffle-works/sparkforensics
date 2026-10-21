import { TriangleAlert } from 'lucide-react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  /** What to show in place of `children` after one of them throws while rendering (or while a
   * lazy chunk fails to load). `reset` clears the error and renders `children` again. */
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** Catches render-time errors below it, so one failing subtree shows `fallback` instead of
 * unmounting the whole page. React supports this only in a class component. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error caught by ErrorBoundary:', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    return error ? this.props.fallback(error, this.reset) : this.props.children;
  }
}

const ALERT_CLASS = 'flex items-start gap-3 rounded-xl border border-l-[3px] border-border border-l-critical bg-card p-4 text-sm text-foreground';

/** The page-level failure view: a render error or a failed chunk load took the page down.
 * `onLoadAnother` is omitted where there is no other log to load (the exported dashboard). */
export function AppCrashView({ error, onLoadAnother }: { error: Error; onLoadAnother?: () => void }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <section role="alert" className={`max-w-prose ${ALERT_CLASS}`}>
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
        <div className="space-y-3">
          <h1 className="font-heading text-lg font-semibold">Something went wrong</h1>
          <p className="text-muted-foreground">
            This page hit an unexpected error and could not be shown. Reloading fixes a stale page after an update.
          </p>
          <p className="font-mono text-xs break-words text-muted-foreground">{error.message}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.location.reload()}>Reload page</Button>
            {onLoadAnother ? (
              <Button size="sm" variant="outline" onClick={onLoadAnother}>Load another log</Button>
            ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}

/** The failure view for one widget card: the rest of the dashboard stays usable. */
export function WidgetErrorCard({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <section role="alert" className={ALERT_CLASS}>
      <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-critical" />
      <div className="min-w-0 space-y-2">
        <p className="font-medium">This card could not be shown.</p>
        <p className="font-mono text-xs break-words text-muted-foreground">{error.message}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>Retry</Button>
      </div>
    </section>
  );
}
