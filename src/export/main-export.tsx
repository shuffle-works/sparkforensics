import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExportRunData } from '@sparkforensics/core/export-data.ts';
import { decodeRunPayload, hydrateExportStore, unsupportedPayloadReason } from './hydrate-store';
import { ExportApp } from './ExportApp';
import { UnsupportedPayload } from './UnsupportedPayload';
import '../index.css';

declare global {
  interface Window {
    __SPARKFORENSICS_RUN_GZ__: string;
  }
}

// Checked before anything renders: a payload version this bundle was not built
// for gets a message naming both versions, never a partial dashboard.
const payload = decodeRunPayload(window.__SPARKFORENSICS_RUN_GZ__);
const unsupported = unsupportedPayloadReason(payload);
if (unsupported == null) hydrateExportStore(payload as ExportRunData);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {unsupported == null ? <ExportApp /> : <UnsupportedPayload reason={unsupported} />}
  </StrictMode>,
);
