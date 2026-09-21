import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitDetectionDocs } from '../scripts/split-detection-docs.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const guide = readFileSync(resolve(root, 'docs-site/user-guide/understanding-findings.md'), 'utf8');
const detectionDir = resolve(root, 'packages/core/src/docs-content/detection');

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

  // getFindingDocumentation reads `<typeTag(type).toLowerCase()>.md` but this
  // script writes `<anchor>.md`; nothing else asserts they agree, so a heading
  // edit changing one would break the MCP tool with a raw ENOENT.
  it('every section anchor matches its tag lowercased (couples the file name mcp-tools.ts reads to the one this script writes)', () => {
    for (const s of splitDetectionDocs(guide)) {
      expect(s.anchor).toBe(s.tag.toLowerCase());
    }
  });

  // Staleness guard: re-split the guide in memory and diff against the committed
  // files, so a guide edit that forgets `npm run split-detection-docs` fails CI.
  it('matches the committed packages/core/src/docs-content/detection/*.md files', () => {
    const sections = splitDetectionDocs(guide);
    const committedFiles = readdirSync(detectionDir).filter((f) => f.endsWith('.md')).sort();
    expect(committedFiles).toEqual(sections.map((s) => `${s.anchor}.md`).sort());
    for (const s of sections) {
      const committed = readFileSync(resolve(detectionDir, `${s.anchor}.md`), 'utf8');
      expect(committed).toBe(s.content);
    }
  });
});
