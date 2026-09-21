import { useState } from 'react';
import { Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useStore } from '@/store/store';
import { buildEvidenceReport } from '@sparkforensics/core/evidence-report.ts';

// Same Blob + object-URL download pattern as PlanExplorer's .dot export.
function triggerDownload(content: string, filename: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// A raw and a redacted export must not be name-identical: attaching the wrong
// one to a public ticket is exactly the mistake the redact toggle guards
// against. Name from the report's own app id (already the `app-1` pseudonym
// when redacted, so the real id never leaks via the filename) plus a
// `-redacted` marker when the toggle is on.
function reportFilename(appId: string | null, format: 'markdown' | 'json', redacted: boolean) {
  const safeId = String(appId ?? 'report').replace(/[^\w.-]/g, '_');
  const suffix = redacted ? '-redacted' : '';
  const ext = format === 'json' ? 'json' : 'md';
  return `evidence-${safeId}${suffix}.${ext}`;
}

/** Shared export state + download action, reused by the standalone control and
 * the Topbar overflow menu so both entry points behave identically. */
export function useEvidenceExport() {
  const appModel = useStore((s) => s.appModel);
  const [redact, setRedact] = useState(false);

  const download = (format: 'markdown' | 'json') => {
    const { markdown, json } = buildEvidenceReport(appModel, { redact });
    const appId = (json as { summary?: { app?: { id?: string | null } } }).summary?.app?.id ?? null;
    const filename = reportFilename(appId, format, redact);
    if (format === 'json') {
      triggerDownload(`${JSON.stringify(json, null, 2)}\n`, filename, 'application/json');
    } else {
      triggerDownload(`${markdown}\n`, filename, 'text/markdown');
    }
  };

  return { redact, setRedact, download };
}

/** The redact toggle + two download items. Rendered inside both the standalone
 * dropdown and the mobile overflow menu, so the export path is reachable at
 * every breakpoint. */
export function EvidenceExportMenuItems({
  redact,
  setRedact,
  download,
}: ReturnType<typeof useEvidenceExport>) {
  return (
    <>
      <DropdownMenuCheckboxItem
        checked={redact}
        onClick={(event) => event.preventDefault()}
        onCheckedChange={(value) => setRedact(Boolean(value))}
      >
        Redact identifiers
      </DropdownMenuCheckboxItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => download('markdown')}>Download Markdown</DropdownMenuItem>
      <DropdownMenuItem onClick={() => download('json')}>Download JSON</DropdownMenuItem>
    </>
  );
}

/** Topbar control: exports the current run's findings as a portable evidence
 * report (Markdown or JSON), with an opt-in identifier-redaction toggle. */
export function EvidenceExport() {
  const evidence = useEvidenceExport();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" />}>
        <Download aria-hidden="true" />
        Export evidence
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <EvidenceExportMenuItems {...evidence} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
