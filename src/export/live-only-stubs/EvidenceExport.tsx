import type * as Live from '@/view/EvidenceExport';
import { notInExport } from './not-in-export';

// Stands in for src/view/EvidenceExport.tsx, whose downloads rerun analysis
// (evidence-report.ts, html-export.ts). The Topbar renders none of it in export mode.
export const useEvidenceExport: typeof Live.useEvidenceExport = () => ({
  redact: false,
  setRedact: notInExport('setRedact'),
  download: notInExport('download'),
});

export function EvidenceExportMenuItems(_props: Parameters<typeof Live.EvidenceExportMenuItems>[0]): null {
  return null;
}

export function EvidenceExport(): null {
  return null;
}
