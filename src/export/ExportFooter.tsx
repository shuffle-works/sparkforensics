import { useStore } from '@/store/store';

/** Build ids are content hashes; the first 12 hex digits identify one well enough to read aloud. */
const SHORT_BUILD_ID_LENGTH = 12;

/** Names what produced this file (tool, core version, core build), so support
 * can tell which analysis a shared export carries. */
export function ExportFooter() {
  const provenance = useStore((s) => s.exportProvenance);
  if (!provenance) return null;
  const { producer, coreVersion, buildId } = provenance;
  return (
    <footer data-testid="export-provenance" className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
      Exported by {producer} · core {coreVersion} · build{' '}
      <span className="font-mono" title={buildId}>{buildId.slice(0, SHORT_BUILD_ID_LENGTH)}</span>
    </footer>
  );
}
