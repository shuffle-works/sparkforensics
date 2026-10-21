import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RUN_PAYLOAD_GLOBAL } from '@sparkforensics/core/run-payload.ts';
import { AppCrashView, ErrorBoundary } from '@/view/ErrorBoundary';
import { loadExportPayload } from './hydrate-store';
import { ExportApp } from './ExportApp';
import { UnsupportedPayload } from './UnsupportedPayload';
import '../index.css';

// Checked before anything renders: a payload version this bundle was not built
// for gets a message naming both versions, never a partial dashboard, and a
// missing or damaged data.js gets a message too, never a blank page.
// Assigned by data.js (runPayloadScript), which index.export.html loads first.
const encoded = (window as unknown as Record<string, unknown>)[RUN_PAYLOAD_GLOBAL];
const unsupported = loadExportPayload(encoded);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {unsupported == null ? (
      <ErrorBoundary fallback={(error) => <AppCrashView error={error} />}>
        <ExportApp />
      </ErrorBoundary>
    ) : (
      <UnsupportedPayload reason={unsupported} />
    )}
  </StrictMode>,
);
