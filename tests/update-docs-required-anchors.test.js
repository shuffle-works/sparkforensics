import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DETECTORS } from '@sparkforensics/core/detectors.ts';
import { KNOWN_DOC_ANCHORS } from '@sparkforensics/core/docs-config.ts';
import { collectRequiredAnchors } from '../scripts/update-docs.mjs';

describe('collectRequiredAnchors', () => {
  let root;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'required-anchors-'));
    mkdirSync(join(root, 'view', 'widgets'), { recursive: true });
    mkdirSync(join(root, 'core'));
    writeFileSync(join(root, 'view', 'widgets', 'Card.tsx'), '<DocsLink anchor="#config-autoscale-bounds" /> #bottleneck-skew');
    writeFileSync(join(root, 'core', 'detectors.ts'), "docAnchor: '#bottleneck-skew', '#metric-task-duration'");
    writeFileSync(join(root, 'core', 'notes.md'), '#bottleneck-ignored-in-markdown');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('scans every given dir recursively, .js/.ts/.tsx only, bare, deduped and sorted', () => {
    expect(collectRequiredAnchors([join(root, 'view'), join(root, 'core')], [])).toEqual([
      'bottleneck-skew', 'config-autoscale-bounds', 'metric-task-duration',
    ]);
  });

  it('adds every allowlisted anchor, page anchors included, with the # stripped', () => {
    expect(collectRequiredAnchors([join(root, 'core')], ['#joins', '#bottleneck-skew'])).toEqual([
      'bottleneck-skew', 'joins', 'metric-task-duration',
    ]);
  });

  // Regression: the scan used to cover src/ only, so once the detectors moved to
  // packages/core/src/ it gated 3 of the 40 anchors the app links to.
  it('covers every detector docAnchor and every allowlisted anchor in the real repo', () => {
    const required = new Set(collectRequiredAnchors());
    const detectorAnchors = [...new Set(DETECTORS.map((d) => d.docAnchor).filter(Boolean))];
    expect(detectorAnchors.filter((a) => !required.has(a.replace(/^#/, '')))).toEqual([]);
    expect([...KNOWN_DOC_ANCHORS].filter((a) => !required.has(a.replace(/^#/, '')))).toEqual([]);
  });
});
