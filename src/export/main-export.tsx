import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ExportRunData } from '@sparkforensics/core/export-data.ts';
import { RUN_PAYLOAD_GLOBAL } from '@sparkforensics/core/html-export.ts';
import { decodeRunPayload, hydrateExportStore, unsupportedPayloadReason } from './hydrate-store';
import { ExportApp } from './ExportApp';
import { UnsupportedPayload } from './UnsupportedPayload';
import '../index.css';

// Checked before anything renders: a payload version this bundle was not built
// for gets a message naming both versions, never a partial dashboard.
// Assigned by data.js (runPayloadScript), which index.export.html loads first.
const encoded = (window as unknown as Record<string, string>)[RUN_PAYLOAD_GLOBAL];
const payload = decodeRunPayload(encoded);
const unsupported = unsupportedPayloadReason(payload);
if (unsupported == null) hydrateExportStore(payload as ExportRunData);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {unsupported == null ? <ExportApp /> : <UnsupportedPayload reason={unsupported} />}
  </StrictMode>,
);
