// Offline render step: turns the committed tuning-reference markdown (written
// by scripts/fetch-tuning-docs.mjs from the pin in upstream.json) into
// VitePress pages under docs-site/, one per manifest entry. Only reshapes
// markdown (inject manifest anchor onto each h1, rewrite same-page cross-refs
// into sibling-page links); VitePress renders HTML.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageForAnchor, isKnownDocAnchor } from '../packages/core/src/docs-config.ts';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS_CONTENT = join(REPO_ROOT, 'packages', 'core', 'src', 'docs-content');
const OUT_SPARK = join(REPO_ROOT, 'docs-site', 'tuning-reference');
const DIAGRAMS_SRC = join(DOCS_CONTENT, 'diagrams');
// Alongside the generated pages (not docs-site/public/): VitePress resolves
// markdown img/srcset paths as real Vite asset imports relative to the page on
// disk, so diagrams must be real files reachable by a plain relative path.
const OUT_DIAGRAMS = join(OUT_SPARK, 'diagrams');

export function injectHeadingAnchor(md, anchor) {
  const lines = md.split('\n');
  const i = lines.findIndex((l) => /^# \S/.test(l));
  if (i === -1 || /\{#[a-z0-9-]+\}\s*$/.test(lines[i])) return md;
  lines[i] = `${lines[i].replace(/\s*$/, '')} {#${anchor}}`;
  return lines.join('\n');
}

// isKnown takes a '#'-prefixed anchor (matches isKnownDocAnchor); resolvePage
// takes the bare anchor (matches pageForAnchor).
export function rewriteCrossLinks(md, pageAnchor, isKnown, resolvePage) {
  return md.replace(/\]\(#([a-z0-9-]+)\)/g, (whole, target) => {
    if (!isKnown(`#${target}`)) return whole;
    const owner = resolvePage(target);
    if (owner === pageAnchor) return whole;
    return owner === target ? `](./${owner})` : `](./${owner}#${target})`;
  });
}

function sourceFileFor(entry) {
  return join(DOCS_CONTENT, entry.store, `${entry.slug}.md`);
}

// Chapters reference 'diagrams/x.svg', bottlenecks '../diagrams/x.svg'; all
// pages land flat in OUT_SPARK, so normalize both to './diagrams/x.svg'. The
// leading './' is required: Vue's asset-url transform treats a bare
// 'diagrams/...' as a module specifier, and Rollup then fails to resolve it.
export function rewriteDiagramPaths(md) {
  return md.replace(/(?:\.\.\/)?diagrams\//g, './diagrams/');
}

// Copies committed diagram SVGs next to the generated pages so each './diagrams/
// x.svg' resolves to a real file for Vite.
function copyDiagrams() {
  rmSync(OUT_DIAGRAMS, { recursive: true, force: true });
  if (!existsSync(DIAGRAMS_SRC)) return;
  mkdirSync(OUT_DIAGRAMS, { recursive: true });
  cpSync(DIAGRAMS_SRC, OUT_DIAGRAMS, { recursive: true });
}

// Deletes every generated page but preserves the hand-authored index.md (no
// manifest anchor is "index", so *.md except index.md is safe to remove).
// Clearing all of them (not just the current anchor set) also drops stale pages
// left behind when an upstream anchor is renamed or removed.
function cleanGenerated(outDir) {
  if (!existsSync(outDir)) { mkdirSync(outDir, { recursive: true }); return; }
  for (const f of readdirSync(outDir)) {
    if (f === 'index.md') continue;
    if (f.endsWith('.md')) rmSync(join(outDir, f));
  }
}

// isKnown/resolvePage drive rewriteCrossLinks; the docs-config pair also
// resolves metric/config/stage sub-anchors that aren't their own nav entries.
function renderCorpus(navIndexPath, outDir, isKnown, resolvePage) {
  const nav = JSON.parse(readFileSync(navIndexPath, 'utf8'));
  cleanGenerated(outDir);
  for (const entry of nav) {
    let md = readFileSync(sourceFileFor(entry), 'utf8');
    md = injectHeadingAnchor(md, entry.anchor);
    md = rewriteCrossLinks(md, entry.anchor, isKnown, resolvePage);
    md = rewriteDiagramPaths(md);
    const front = `---\ntitle: ${JSON.stringify(entry.title)}\n---\n\n`;
    writeFileSync(join(outDir, `${entry.anchor}.md`), front + md);
  }
}

function main() {
  copyDiagrams();
  renderCorpus(join(DOCS_CONTENT, 'chapters', 'nav-index.json'), OUT_SPARK, isKnownDocAnchor, pageForAnchor);
  console.log('build-tuning-reference: generated tuning-reference/ pages.');
}

if (process.argv[1] && join(process.argv[1]) === fileURLToPath(import.meta.url)) main();
