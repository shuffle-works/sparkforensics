import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { failedDependency, recordPublishedTag } from '../scripts/publish-packages.mjs';

function tempOutputPath() {
  return join(mkdtempSync(join(tmpdir(), 'changesets-output-')), 'out.ndjson');
}

describe('recordPublishedTag', () => {
  it('appends one changesets/action git-tag record per call, one JSON object per line', () => {
    const outputPath = tempOutputPath();
    recordPublishedTag(outputPath, 'sparkforensics-cli', '0.2.3');
    recordPublishedTag(outputPath, 'sparkforensics-mcp', '0.2.3');

    const lines = readFileSync(outputPath, 'utf8').split('\n');
    expect(lines.pop()).toBe('');
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: 'git-tag', tag: 'sparkforensics-cli@0.2.3', packageName: 'sparkforensics-cli' },
      { type: 'git-tag', tag: 'sparkforensics-mcp@0.2.3', packageName: 'sparkforensics-mcp' },
    ]);
  });

  it('writes nothing when CHANGESETS_OUTPUT is unset', () => {
    const outputPath = tempOutputPath();
    recordPublishedTag(undefined, 'sparkforensics-cli', '0.2.3');
    recordPublishedTag('', 'sparkforensics-cli', '0.2.3');
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe('failedDependency', () => {
  it('blocks the alias packages when sparkforensics-cli failed, but not the independent ones', () => {
    const failed = new Set(['sparkforensics-cli']);
    for (const dir of ['packages/analyze', 'packages/sparkforensics']) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(failedDependency(manifest, failed)).toBe('sparkforensics-cli');
    }
    for (const dir of ['packages/mcp', 'packages/server']) {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      expect(failedDependency(manifest, failed)).toBeUndefined();
    }
  });

  it('blocks nothing when no package failed', () => {
    const manifest = JSON.parse(readFileSync('packages/analyze/package.json', 'utf8'));
    expect(failedDependency(manifest, new Set())).toBeUndefined();
  });
});
