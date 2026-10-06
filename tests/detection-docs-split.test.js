import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDetectionDocs, splitDetectionDocs } from '../scripts/split-detection-docs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const guideFile = resolve(root, 'docs-site/user-guide/understanding-findings.md');
const guide = readFileSync(guideFile, 'utf8');
const detectionDir = resolve(root, 'packages/core/src/docs-content/detection');

const files = (d) => readdirSync(d).sort();
const expectedFiles = () => splitDetectionDocs(guide).map((s) => `${s.anchor}.md`).sort();

describe('splitDetectionDocs', () => {
  it('produces exactly one section per ### `TAG` heading in the guide', () => {
    const sections = splitDetectionDocs(guide);
    const tags = sections.map((s) => s.tag).sort();
    const headingTags = [...guide.matchAll(/^### `([A-Z]+)`/gm)].map((m) => m[1]).sort();
    expect(tags).toEqual(headingTags);
  });

  it('every section starts with its own ### `TAG` heading', () => {
    for (const s of splitDetectionDocs(guide)) {
      expect(s.content.startsWith(`### \`${s.tag}\``)).toBe(true);
    }
  });

  // getFindingDocumentation reads `<typeTag(type).toLowerCase()>.md` but the
  // split writes `<anchor>.md`; nothing else asserts they agree, so a heading
  // edit changing one would break the MCP tool with a raw ENOENT.
  it('every section anchor matches its tag lowercased (couples the file name mcp-tools.ts reads to the one the split writes)', () => {
    for (const s of splitDetectionDocs(guide)) {
      expect(s.anchor).toBe(s.tag.toLowerCase());
    }
  });
});

describe('ensureDetectionDocs', () => {
  let dir;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'detection-docs-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes one file per section, then leaves a matching directory untouched', () => {
    const out = join(dir, 'detection');
    expect(ensureDetectionDocs({ guideFile, detectionDir: out })).toBe(true);
    expect(files(out)).toEqual(expectedFiles());
    for (const s of splitDetectionDocs(guide)) {
      expect(readFileSync(join(out, `${s.anchor}.md`), 'utf8')).toBe(s.content);
    }
    expect(ensureDetectionDocs({ guideFile, detectionDir: out })).toBe(false);
  });

  it('repairs a drifted file and removes a stray one', () => {
    const out = join(dir, 'detection');
    ensureDetectionDocs({ guideFile, detectionDir: out });
    writeFileSync(join(out, 'skew.md'), 'stale\n');
    writeFileSync(join(out, 'gone.md'), 'stray\n');
    expect(ensureDetectionDocs({ guideFile, detectionDir: out })).toBe(true);
    expect(files(out)).toEqual(expectedFiles());
    expect(readFileSync(join(out, 'skew.md'), 'utf8')).not.toBe('stale\n');
  });

  it('refuses a guide with no tag sections', () => {
    const empty = join(dir, 'empty.md');
    writeFileSync(empty, '# nothing here\n');
    expect(() => ensureDetectionDocs({ guideFile: empty, detectionDir: join(dir, 'd') })).toThrow(/no ### `TAG` sections/);
  });
});

// The globalSetup has run by now, so the real directory is generated and complete.
describe('generated detection docs directory', () => {
  it('holds exactly one non-empty file per guide section', () => {
    expect(files(detectionDir)).toEqual(expectedFiles());
    for (const name of files(detectionDir)) {
      expect(readFileSync(join(detectionDir, name), 'utf8').length).toBeGreaterThan(0);
    }
  });
});
