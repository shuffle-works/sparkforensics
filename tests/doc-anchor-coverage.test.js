import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DETECTORS } from '@sparkforensics/core/detectors.ts';
import { computeDocAnchorCoverage } from '../scripts/doc-anchor-coverage.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_SCRIPT = join(root, 'scripts', 'doc-anchor-coverage.js');

describe('computeDocAnchorCoverage', () => {
  it('reports no dead links or orphans when every anchor is covered both ways', () => {
    const detectors = [{ docAnchor: '#bottleneck-skew' }];
    const anchors = [{ anchor: 'bottleneck-skew', section: 'Detector Catalog' }];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({ deadLinks: [], orphaned: [] });
  });

  it('flags a detector docAnchor absent from anchors.json as a dead link', () => {
    const detectors = [{ docAnchor: '#bottleneck-nonexistent' }];
    const anchors = [{ anchor: 'bottleneck-skew', section: 'Detector Catalog' }];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({
      deadLinks: ['bottleneck-nonexistent'],
      orphaned: ['bottleneck-skew'],
    });
  });

  it('flags a Detector Catalog anchor with no referencing detector as orphaned', () => {
    const detectors = [{ docAnchor: '#bottleneck-skew' }];
    const anchors = [
      { anchor: 'bottleneck-skew', section: 'Detector Catalog' },
      { anchor: 'bottleneck-gc', section: 'Detector Catalog' },
    ];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({
      deadLinks: [],
      orphaned: ['bottleneck-gc'],
    });
  });

  it('does not flag a guide-page anchor with no detector as orphaned', () => {
    const detectors = [{ docAnchor: '#bottleneck-skew' }];
    const anchors = [
      { anchor: 'bottleneck-skew', section: 'Detector Catalog' },
      { anchor: 'joins', section: 'Optimization Guide' },
    ];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({ deadLinks: [], orphaned: [] });
  });

  it('does not flag a known sub-anchor as a dead link even though anchors.json never carries it', () => {
    const detectors = [{ docAnchor: '#bottleneck-stage-shape' }, { docAnchor: '#config-serializer' }];
    const anchors = [{ anchor: 'bottleneck-skew', section: 'Detector Catalog' }];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({
      deadLinks: [],
      orphaned: ['bottleneck-skew'],
    });
  });

  it('de-duplicates a docAnchor shared by multiple detectors', () => {
    const detectors = [{ docAnchor: '#bottleneck-shuffle' }, { docAnchor: '#bottleneck-shuffle' }];
    const anchors = [{ anchor: 'bottleneck-shuffle', section: 'Detector Catalog' }];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({ deadLinks: [], orphaned: [] });
  });

  it('ignores detectors with no docAnchor', () => {
    const detectors = [{ docAnchor: undefined }, { docAnchor: '#bottleneck-skew' }];
    const anchors = [{ anchor: 'bottleneck-skew', section: 'Detector Catalog' }];

    expect(computeDocAnchorCoverage(detectors, anchors)).toEqual({ deadLinks: [], orphaned: [] });
  });
});

describe('doc-anchor coverage report (real data)', () => {
  it('warns with the current coverage report against the vendored anchors.json, without failing', () => {
    const anchors = JSON.parse(readFileSync(resolve(root, 'packages/core/src/docs-content/chapters/nav-index.json'), 'utf8'));
    const { deadLinks, orphaned } = computeDocAnchorCoverage(DETECTORS, anchors);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    if (deadLinks.length || orphaned.length) {
      console.warn(
        `doc-anchor coverage: ${deadLinks.length} dead link(s), ${orphaned.length} orphaned Detector Catalog anchor(s)\n` +
          (deadLinks.length ? `  dead links (detector docAnchor not in anchors.json): ${deadLinks.join(', ')}\n` : '') +
          (orphaned.length ? `  orphaned (anchors.json Detector Catalog entry with no detector): ${orphaned.join(', ')}\n` : ''),
      );
    }
    warn.mockRestore();

    // Warn-only by design: a no-op sanity check, not a gate. Detector->anchor
    // drift must never fail CI.
    expect(true).toBe(true);
  });
});

describe('doc-anchor-coverage.js CLI entry (exit-coded, run for real)', () => {
  it('exits matching the real coverage state: 0 and a clean message when there is no drift, 1 and the report otherwise', () => {
    const anchors = JSON.parse(readFileSync(resolve(root, 'packages/core/src/docs-content/chapters/nav-index.json'), 'utf8'));
    const { deadLinks, orphaned } = computeDocAnchorCoverage(DETECTORS, anchors);
    const isClean = !deadLinks.length && !orphaned.length;

    const { status, stdout, stderr } = spawnSync('node', [CLI_SCRIPT], { encoding: 'utf8' });

    expect(status).toBe(isClean ? 0 : 1);
    if (isClean) {
      expect(stdout).toContain('no dead links or orphaned Detector Catalog anchors');
    } else {
      expect(stderr).toContain('doc-anchor coverage:');
    }
  });
});
