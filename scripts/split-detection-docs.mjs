// Splits docs-site/user-guide/understanding-findings.md into one committed file
// per tag under packages/core/src/docs-content/detection/, so the MCP tool
// get_finding_documentation can read a finding's detection reference off disk
// with no parser. Plain string/regex only (splits Markdown headings, not HTML).
//
// Run: npm run split-detection-docs
// Regenerate whenever understanding-findings.md changes; a stale split fails
// tests/detection-docs-split.test.js.
import { readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_FILE = join(REPO_ROOT, 'docs-site', 'user-guide', 'understanding-findings.md');
const DETECTION_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content', 'detection');

const SECTION_HEADING_RE = /^### `([A-Z]+)`.*\{#([a-z0-9-]+)\}\s*$/;

// Pure, no filesystem access: unit-tested directly, and reused by
// tests/detection-docs-split.test.js's staleness check.
export function splitDetectionDocs(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(SECTION_HEADING_RE);
    if (heading) {
      if (current) sections.push(current);
      current = { tag: heading[1], anchor: heading[2], lines: [line] };
      continue;
    }
    if (current) {
      if (line.startsWith('## ')) {
        sections.push(current);
        current = null;
        continue;
      }
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);
  return sections.map(({ tag, anchor, lines: sectionLines }) => ({
    tag,
    anchor,
    // Trim trailing blank lines, then restore exactly one trailing newline.
    content: `${sectionLines.join('\n').replace(/\n+$/, '')}\n`,
  }));
}

function main() {
  const guide = readFileSync(GUIDE_FILE, 'utf8');
  const sections = splitDetectionDocs(guide);
  if (sections.length === 0) {
    console.error('split-detection-docs: no ### `TAG` sections found; refusing to write an empty directory.');
    process.exit(1);
  }
  rmSync(DETECTION_DIR, { recursive: true, force: true });
  mkdirSync(DETECTION_DIR, { recursive: true });
  for (const { anchor, content } of sections) {
    writeFileSync(join(DETECTION_DIR, `${anchor}.md`), content);
  }
  console.log(`split-detection-docs: wrote ${sections.length} file(s) to ${DETECTION_DIR}.`);
}

function isDirectExecution() {
  return process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) main();
