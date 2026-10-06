// Generates packages/core/src/docs-content/detection/ (gitignored): one file per
// finding tag, split from docs-site/user-guide/understanding-findings.md, so the
// MCP tool get_finding_documentation can read a finding's detection reference
// off disk with no parser. Plain string/regex only (splits Markdown headings,
// not HTML).
//
// ensureDetectionDocs() is the one entry point every consumer calls: docs:dev
// and docs:build (package.json), vendor-core.mjs (every npm pack), and the
// vitest globalSetup. It is idempotent: files already matching the guide are
// left untouched. Running this file directly does the same.
import { existsSync, readFileSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GUIDE_FILE = join(REPO_ROOT, 'docs-site', 'user-guide', 'understanding-findings.md');
export const DETECTION_DIR = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content', 'detection');

const SECTION_HEADING_RE = /^### `([A-Z]+)`.*\{#([a-z0-9-]+)\}\s*$/;

// Pure, no filesystem access: unit-tested directly.
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

// Makes detectionDir hold exactly the sections of the guide, writing only when
// its current files differ. Returns whether it wrote.
export function ensureDetectionDocs({ guideFile = GUIDE_FILE, detectionDir = DETECTION_DIR } = {}) {
  const sections = splitDetectionDocs(readFileSync(guideFile, 'utf8'));
  if (sections.length === 0) {
    throw new Error('split-detection-docs: no ### `TAG` sections found; refusing to write an empty directory.');
  }
  const wanted = new Map(sections.map(({ anchor, content }) => [`${anchor}.md`, content]));
  const present = existsSync(detectionDir) ? readdirSync(detectionDir) : [];
  const upToDate =
    present.length === wanted.size &&
    [...wanted].every(([name, content]) => {
      const file = join(detectionDir, name);
      return existsSync(file) && readFileSync(file, 'utf8') === content;
    });
  if (upToDate) return false;
  rmSync(detectionDir, { recursive: true, force: true });
  mkdirSync(detectionDir, { recursive: true });
  for (const [name, content] of wanted) writeFileSync(join(detectionDir, name), content);
  return true;
}

function main() {
  try {
    const wrote = ensureDetectionDocs();
    console.log(`split-detection-docs: ${wrote ? 'wrote' : 'kept'} ${DETECTION_DIR}.`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function isDirectExecution() {
  return process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) main();
