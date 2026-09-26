// Kept dependency-free so vite.export.config.ts can import it too.

/** Where the main build ships the built export app, next to its own
 * index.html. The dashboard fetches it only when a user downloads an HTML
 * export (see EvidenceExport.tsx), so page loads never pay for it. */
export const EXPORT_TEMPLATE_FILE = 'export-template.html';
