import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeRunPayload, hydrateExportStore } from './hydrate-store';
import { ExportApp } from './ExportApp';
import { setDocsBases, type DocsBases } from '@/view/docs-href';
import '../index.css';

declare global {
  interface Window {
    __SPARKFORENSICS_RUN_GZ__: string;
    // Set only by the dashboard's non-redacted single-file download, which
    // has no docs/ folder beside it (see src/export/single-file.ts).
    __SPARKFORENSICS_DOCS_BASES__?: DocsBases;
  }
}

// The CLI's export folder keeps the data.js tag and ships docs/ beside it; a
// single-file download inlines the tag away.
const singleFile = !document.querySelector('script[src="./data.js"]');
setDocsBases(window.__SPARKFORENSICS_DOCS_BASES__ ?? (singleFile ? 'none' : null));
hydrateExportStore(decodeRunPayload(window.__SPARKFORENSICS_RUN_GZ__));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExportApp />
  </StrictMode>,
);
