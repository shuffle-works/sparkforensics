import type { ReactNode } from 'react';
import { useIngest } from '@/store/useIngest';
import { AppCrashView, ErrorBoundary } from '@/view/ErrorBoundary';

/** Root boundary of the live app. "Load another log" drops the half-built run and returns to the
 * drop zone, then renders the app again. Kept out of ErrorBoundary.tsx so the export bundle, which
 * has no ingest path, never pulls in `useIngest`. */
export function AppErrorBoundary({ children }: { children: ReactNode }) {
  const { cancelParse } = useIngest();
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <AppCrashView
          error={error}
          onLoadAnother={() => {
            cancelParse();
            reset();
          }}
        />
      )}
    >
      {children}
    </ErrorBoundary>
  );
}
