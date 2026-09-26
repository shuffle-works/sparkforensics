// Every docs link in the app is relative (`docs/...`), which resolves to the
// docs site shipped next to the app: dist/docs in the hosted and server
// builds, <export dir>/docs in the CLI's --export-html folder. A single-file
// HTML download (EvidenceExport.tsx) has no folder around it to carry the docs,
// so it switches this module to the published docs instead, where the guide
// lives under the app and the tuning reference is its own site. Links still
// work when the file is mailed around; opening them needs a network.

const PUBLISHED_DOCS_ROOT = 'https://shuffle-works.github.io/sparkforensics/';
const PUBLISHED_TUNING_REFERENCE_ROOT = 'https://shuffle-works.github.io/spark-tuning-reference/';
const LOCAL_TUNING_REFERENCE_PREFIX = 'docs/tuning-reference/';

let usePublished = false;

/** Called once at boot by the export app when its payload asks for it. */
export function setPublishedDocs(value: boolean): void {
  usePublished = value;
}

/** Resolves an app-relative docs path (`docsUrl()`, `findingGuideUrl()`, the
 * docs root) to the URL the current build can actually open. */
export function docsHref(path: string): string {
  if (!usePublished) return path;
  if (path.startsWith(LOCAL_TUNING_REFERENCE_PREFIX)) {
    return PUBLISHED_TUNING_REFERENCE_ROOT + path.slice(LOCAL_TUNING_REFERENCE_PREFIX.length);
  }
  return PUBLISHED_DOCS_ROOT + path;
}
