import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETECTORS } from '../packages/core/src/detectors.ts';
import { DieError, ensureTuningDocs } from './fetch-tuning-docs.mjs';

// Detector -> doc-anchor coverage contract: every detector docAnchor must
// resolve to a real nav-index.json entry (else a dead deep-link), and every
// Detector Catalog anchor should have a detector (else an orphaned page).
// Guide/glossary/reference anchors are excluded from the orphan side; only
// Detector Catalog entries are meant to be 1:1 with a detector.
//
// These sub-anchors live inside a manifest entry's page, not as their own
// entries, so nav-index has no record for them; a detector pointing at one is
// not a dead link.
const KNOWN_SUB_ANCHORS = new Set([
  'bottleneck-stage-shape',
  'bottleneck-stage-slowness',
  'config-shuffle-service',
  'config-autoscale-bounds',
  'config-serializer',
  'config-memory-overhead',
]);

export function computeDocAnchorCoverage(detectors, anchors) {
  const anchorIds = new Set(anchors.map((a) => a.anchor));
  const detectorAnchors = new Set(
    detectors.map((d) => d.docAnchor).filter(Boolean).map((a) => a.replace(/^#/, '')),
  );

  const deadLinks = [...detectorAnchors]
    .filter((a) => !anchorIds.has(a) && !KNOWN_SUB_ANCHORS.has(a))
    .sort();
  const orphaned = anchors
    .filter((a) => a.section === 'Detector Catalog' && !detectorAnchors.has(a.anchor))
    .map((a) => a.anchor)
    .sort();

  return { deadLinks, orphaned };
}

export function isDirectExecution(scriptPath = process.argv[1], moduleUrl = import.meta.url) {
  return Boolean(scriptPath) && resolve(scriptPath) === fileURLToPath(moduleUrl);
}

// CLI entry: same report as tests/doc-anchor-coverage.test.js but exit-coded.
// A maintainer health check, not part of `npm test` (that test stays warn-only;
// detector<->anchor drift must never fail the suite).
function main() {
  try {
    ensureTuningDocs({ allowStale: true });
  } catch (err) {
    if (!(err instanceof DieError)) throw err;
    console.error(`doc-anchor coverage: fetch-tuning-docs: ${err.message}`);
    return 1;
  }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const anchors = JSON.parse(readFileSync(join(root, 'packages/core/src/docs-content/chapters/nav-index.json'), 'utf8'));
  const { deadLinks, orphaned } = computeDocAnchorCoverage(DETECTORS, anchors);

  if (!deadLinks.length && !orphaned.length) {
    console.log('doc-anchor coverage: no dead links or orphaned Detector Catalog anchors.');
    return 0;
  }

  console.error(
    `doc-anchor coverage: ${deadLinks.length} dead link(s), ${orphaned.length} orphaned Detector Catalog anchor(s)\n` +
      (deadLinks.length ? `  dead links (detector docAnchor not in nav-index.json): ${deadLinks.join(', ')}\n` : '') +
      (orphaned.length ? `  orphaned (nav-index.json Detector Catalog entry with no detector): ${orphaned.join(', ')}\n` : ''),
  );
  return 1;
}

if (isDirectExecution()) {
  process.exit(main());
}
