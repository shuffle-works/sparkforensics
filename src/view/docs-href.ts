import { DOCS_BASE_DIR } from '@sparkforensics/core/docs-config.ts';

// Every docs link in the app is relative, which resolves to the docs shipped
// beside the app: dist/docs in the hosted and server builds, <export dir>/docs
// in the CLI's --export-html folder. A single-file HTML download
// (EvidenceExport.tsx) has no folder around it, so it carries the absolute
// docs locations of the deployment it was downloaded from, and the export
// app resolves its links against those. The addresses come from the
// downloading page's own URL, never from this source: a deployment that
// serves its docs elsewhere (a rewritten DOCS_BASE_DIR, a different host)
// hands that location on unchanged. Opening the links needs that deployment
// to be reachable.

const SITE_PREFIX = 'docs/';
const TUNING_REFERENCE_PREFIX = `${DOCS_BASE_DIR}/`;

/** Absolute locations of the two docs trees a relative docs path points into. */
export interface DocsBases {
  /** Where `docs/...` (the guide and docs root) lives. */
  site: string;
  /** Where `${DOCS_BASE_DIR}/...` (the tuning reference) lives. */
  tuningReference: string;
}

/** Resolves this build's docs prefixes against the page they load from, i.e.
 * what a relative docs link on `pageUrl` would open. */
export function docsBasesFor(pageUrl: string): DocsBases {
  return {
    site: new URL(SITE_PREFIX, pageUrl).href,
    tuningReference: new URL(TUNING_REFERENCE_PREFIX, pageUrl).href,
  };
}

let bases: DocsBases | null = null;

/** Called once at boot by the export app with the bases its payload carries;
 * null keeps links relative (the CLI's export folder ships its own docs). */
export function setDocsBases(next: DocsBases | null): void {
  bases = next;
}

/** Resolves an app-relative docs path (`docsUrl()`, `findingGuideUrl()`, the
 * docs root) to the URL the current build can actually open. */
export function docsHref(path: string): string {
  if (!bases) return path;
  if (path.startsWith(TUNING_REFERENCE_PREFIX)) {
    return bases.tuningReference + path.slice(TUNING_REFERENCE_PREFIX.length);
  }
  if (path.startsWith(SITE_PREFIX)) return bases.site + path.slice(SITE_PREFIX.length);
  return path;
}
