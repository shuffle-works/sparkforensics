import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { decodeRunPayload, hydrateExportStore } from './hydrate-store';
import { ExportApp } from './ExportApp';
import '../index.css';

declare global {
  interface Window {
    __SPARKFORENSICS_RUN_GZ__: string;
  }
}

hydrateExportStore(decodeRunPayload(window.__SPARKFORENSICS_RUN_GZ__));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ExportApp />
  </StrictMode>,
);
