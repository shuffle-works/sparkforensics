import { useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';

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
import { buildHtmlExportData, encodeRunPayload } from '@sparkforensics/core/html-export.ts';
import { EXPORT_TEMPLATE_FILE, inlineRunPayload } from '@/export/single-file';

type ExportFormat = 'markdown' | 'json' | 'html';

const FILE_EXTENSIONS: Record<ExportFormat, string> = { markdown: 'md', json: 'json', html: 'html' };

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
function reportFilename(appId: string | null, format: ExportFormat, redacted: boolean) {
  const safeId = String(appId ?? 'report').replace(/[^\w.-]/g, '_');
  const suffix = redacted ? '-redacted' : '';
  return `evidence-${safeId}${suffix}.${FILE_EXTENSIONS[format]}`;
}

/** Fetched on demand, not bundled: the template is the whole export app
 * (~1.8 MB), and only a user who picks HTML should pay for it. */
async function fetchExportTemplate(): Promise<string> {
  const response = await fetch(EXPORT_TEMPLATE_FILE);
  if (!response.ok) throw new Error(`The HTML export template could not be loaded (HTTP ${response.status}).`);
  return response.text();
}

/** Shared export state + download action, reused by the standalone control and
 * the Topbar overflow menu so both entry points behave identically. */
export function useEvidenceExport() {
  const appModel = useStore((s) => s.appModel);
  const catalog = useStore((s) => s.catalog);
  const skippedLines = useStore((s) => s.skippedLines);
  // The export app itself has no template beside it to re-export from.
  const htmlAvailable = !useStore((s) => s.exportMode);
  const [redact, setRedact] = useState(false);

  // Same data, redaction and encoding as the CLI's --export-html
  // (buildHtmlExportData), inlined into one file instead of a data.js beside it.
  const downloadHtml = async () => {
    try {
      const data = buildHtmlExportData(appModel, catalog, skippedLines, { redact });
      const html = inlineRunPayload(await fetchExportTemplate(), encodeRunPayload(data));
      triggerDownload(html, reportFilename(data.app?.id ?? null, 'html', redact), 'text/html');
    } catch (error) {
      console.error('HTML export failed', error);
      toast.error('HTML export failed', { description: error instanceof Error ? error.message : String(error) });
    }
  };

  const download = (format: ExportFormat) => {
    if (format === 'html') {
      void downloadHtml();
      return;
    }
    const { markdown, json } = buildEvidenceReport(appModel, { redact });
    const appId = (json as { summary?: { app?: { id?: string | null } } }).summary?.app?.id ?? null;
    const filename = reportFilename(appId, format, redact);
    if (format === 'json') {
      triggerDownload(`${JSON.stringify(json, null, 2)}\n`, filename, 'application/json');
    } else {
      triggerDownload(`${markdown}\n`, filename, 'text/markdown');
    }
  };

  return { redact, setRedact, download, htmlAvailable };
}

/** The redact toggle + the download items. Rendered inside both the standalone
 * dropdown and the mobile overflow menu, so the export path is reachable at
 * every breakpoint. */
export function EvidenceExportMenuItems({
  redact,
  setRedact,
  download,
  htmlAvailable,
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
      {htmlAvailable ? (
        <DropdownMenuItem onClick={() => download('html')}>Download HTML dashboard</DropdownMenuItem>
      ) : null}
    </>
  );
}

/** Topbar control: exports the current run's findings as a portable evidence
 * report (Markdown or JSON) or a self-contained HTML dashboard, with an
 * opt-in identifier-redaction toggle. */
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
