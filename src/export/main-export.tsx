import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeRunPayload, hydrateExportStore } from './hydrate-store';
import { ExportApp } from './ExportApp';
import { setPublishedDocs } from '@/view/docs-href';
import '../index.css';

declare global {
  interface Window {
    __SPARKFORENSICS_RUN_GZ__: string;
    // Set only by the dashboard's single-file download, which has no docs/
    // folder beside it (see src/export/single-file.ts).
    __SPARKFORENSICS_PUBLISHED_DOCS__?: boolean;
  }
}

setPublishedDocs(window.__SPARKFORENSICS_PUBLISHED_DOCS__ === true);
hydrateExportStore(decodeRunPayload(window.__SPARKFORENSICS_RUN_GZ__));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExportApp />
  </StrictMode>,
);
